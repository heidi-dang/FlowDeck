/**
 * Orchestrator Guard Strategy Circuit
 *
 * Implements an authoritative circuit breaker for repeated orchestrator_guard blocks.
 * Prevents identical blocked tool executions from churning the model (such as 13-attempt loops).
 *
 * Protocol:
 *   - Attempt 1: Deny execution + return exact reason + structured EXECUTABLE ALTERNATIVES.
 *   - Attempt 2 (unchanged blocked fingerprint): Deny immediately + mark strategy INVALIDATED (reason: REPEATED_GUARD_BLOCK) + require different route/tool.
 *   - Attempt 3+ (unchanged blocked fingerprint): Suppress model/tool churn cycle with terminal block error.
 *
 * Resets / resolves:
 *   - When repository generation changes (state mutation).
 *   - When a different evidence-producing action is taken.
 */

export interface BlockedStrategyIncident {
  fingerprint: string
  sessionID: string
  firstBlockedAt: number
  lastBlockedAt: number
  repeatCount: number
  strategyGeneration: number
  status: "active" | "invalidated" | "suppressed"
  reasonCode: string
  reasonText: string
  suggestedActions: string[]
  repoGeneration?: string
}

export interface CircuitEvaluation {
  action: "deny" | "deny_invalidated" | "suppressed"
  repeatCount: number
  incident: BlockedStrategyIncident
  message: string
}

export function normalizeGuardFingerprint(toolName: string, input: unknown): string {
  const tool = (toolName || "tool").toLowerCase().trim()
  let normalizedArgs = ""

  if (typeof input === "string") {
    normalizedArgs = normalizeCommandString(input)
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === "string") {
      normalizedArgs = normalizeCommandString(obj.command)
    } else if (typeof obj.file === "string" || typeof obj.file_path === "string" || typeof obj.filePath === "string") {
      normalizedArgs = String(obj.file || obj.file_path || obj.filePath || "").trim().toLowerCase()
    } else {
      normalizedArgs = JSON.stringify(obj, Object.keys(obj).sort())
    }
  }

  return `${tool}:${normalizedArgs}`
}

function normalizeCommandString(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, " ")
    .replace(/['"]/g, "") // strip quotes so quote variation cannot evade
    .replace(/--description\s+[^\s]+/g, "")
    .trim()
    .slice(0, 300)
}

/**
 * Per-session tool-error repetition counters. Bounds loops from repeated identical tool failures.
 *
 * 3-Attempt Circuit Protocol:
 * - Two identical failure executions are recorded.
 * - The third unchanged attempt is suppressed before execution (TOOL_ERROR_HARD_LIMIT = 2 previous failures).
 */
const _toolErrorCounts = new Map<string, number>()
export const TOOL_ERROR_HARD_LIMIT = 2
const MAX_ERROR_COUNT_ENTRIES = 2000

/**
 * Track a repeated tool error; return whether the hard limit has been hit.
 * Call for any tool throw or failure output to bound infinite retry loops.
 */
export function recordToolError(
  sessionID: string,
  toolName: string,
  inputHash: string,
  errorHash: string,
): { blocked: boolean; count: number } {
  if (_toolErrorCounts.size >= MAX_ERROR_COUNT_ENTRIES) {
    let purged = 0
    for (const k of _toolErrorCounts.keys()) {
      _toolErrorCounts.delete(k)
      if (++purged >= 500) break
    }
  }
  const key = sessionID + ":" + toolName.toLowerCase() + ":" + inputHash.slice(0, 60) + ":" + errorHash.slice(0, 60)
  const count = (_toolErrorCounts.get(key) ?? 0) + 1
  _toolErrorCounts.set(key, count)
  return { blocked: count >= TOOL_ERROR_HARD_LIMIT, count }
}

/** Check whether identical tool + input has triggered the 3-strike circuit breaker. */
export function checkToolErrorCircuit(
  sessionID: string,
  toolName: string,
  inputHash: string,
): { blocked: boolean; maxCount: number } {
  const prefix = sessionID + ":" + toolName.toLowerCase() + ":" + inputHash.slice(0, 60) + ":"
  let maxCount = 0
  for (const [key, count] of _toolErrorCounts.entries()) {
    if (key.startsWith(prefix)) {
      if (count > maxCount) maxCount = count
    }
  }
  return { blocked: maxCount >= TOOL_ERROR_HARD_LIMIT, maxCount }
}

export function clearToolErrorCounts(sessionID: string): void {
  for (const key of _toolErrorCounts.keys()) {
    if (key.startsWith(sessionID + ":")) _toolErrorCounts.delete(key)
  }
}

class OrchestratorGuardStrategyCircuitRegistry {
  private incidents = new Map<string, Map<string, BlockedStrategyIncident>>() // sessionID -> fingerprint -> incident
  private sessionLastAllowedAction = new Map<string, number>()
  private sessionRepoGeneration = new Map<string, string>()

  recordAllowedProgress(sessionID: string, repoGen?: string): void {
    if (!sessionID) return
    this.sessionLastAllowedAction.set(sessionID, Date.now())
    if (repoGen && this.sessionRepoGeneration.get(sessionID) !== repoGen) {
      this.sessionRepoGeneration.set(sessionID, repoGen)
      // Repo generation changed - clear blocked incidents for this session
      this.incidents.delete(sessionID)
    }
  }

  evaluateBlock(params: {
    sessionID: string
    toolName: string
    input: unknown
    reasonCode: string
    reasonText: string
    suggestedActions?: string[]
    repoGeneration?: string
  }): CircuitEvaluation {
    const { sessionID, toolName, input, reasonCode, reasonText, suggestedActions = [], repoGeneration } = params
    const fingerprint = normalizeGuardFingerprint(toolName, input)

    let sessionMap = this.incidents.get(sessionID)
    if (!sessionMap) {
      sessionMap = new Map<string, BlockedStrategyIncident>()
      this.incidents.set(sessionID, sessionMap)
    }

    let incident = sessionMap.get(fingerprint)
    const now = Date.now()

    if (!incident) {
      incident = {
        fingerprint,
        sessionID,
        firstBlockedAt: now,
        lastBlockedAt: now,
        repeatCount: 1,
        strategyGeneration: 1,
        status: "active",
        reasonCode,
        reasonText,
        suggestedActions: suggestedActions.length > 0 ? suggestedActions : [
          "Route execution probe or test to a specialist (@tester, @debug-specialist)",
          "Use read-only inspection tools (fdx-read, fdx-search, fdx-ls)",
          "Check existing test results or documentation before re-attempting",
        ],
        repoGeneration,
      }
      sessionMap.set(fingerprint, incident)

      const structuredMsg = buildCircuitErrorMessage(incident, "deny")
      return {
        action: "deny",
        repeatCount: 1,
        incident,
        message: structuredMsg,
      }
    }

    // Incident already exists - increment repeat count
    incident.repeatCount++
    incident.lastBlockedAt = now

    if (incident.repeatCount === 2) {
      incident.status = "invalidated"
      incident.strategyGeneration++
      const structuredMsg = buildCircuitErrorMessage(incident, "deny_invalidated")
      return {
        action: "deny_invalidated",
        repeatCount: 2,
        incident,
        message: structuredMsg,
      }
    }

    // repeatCount >= 3 -> Suppressed
    incident.status = "suppressed"
    const structuredMsg = buildCircuitErrorMessage(incident, "suppressed")
    return {
      action: "suppressed",
      repeatCount: incident.repeatCount,
      incident,
      message: structuredMsg,
    }
  }

  getIncident(sessionID: string, fingerprint: string): BlockedStrategyIncident | undefined {
    return this.incidents.get(sessionID)?.get(fingerprint)
  }

  clearSession(sessionID: string): void {
    this.incidents.delete(sessionID)
    this.sessionLastAllowedAction.delete(sessionID)
    this.sessionRepoGeneration.delete(sessionID)
  }

  clearAll(): void {
    this.incidents.clear()
    this.sessionLastAllowedAction.clear()
    this.sessionRepoGeneration.clear()
  }
}

function buildCircuitErrorMessage(incident: BlockedStrategyIncident, action: "deny" | "deny_invalidated" | "suppressed"): string {
  const lines: string[] = []

  if (action === "suppressed") {
    lines.push(`[Orchestrator Guard Circuit Breaker: REPEATED_GUARD_BLOCK_SUPPRESSED]`)
    lines.push(`The orchestrator has attempted this blocked operation ${incident.repeatCount} times without changing strategy.`)
    lines.push(`To prevent token exhaustion loops, execution is halted on this path.`)
    lines.push(`\nMandatory next step: Route this task to a specialist subagent or choose an allowed read-only inspection tool.`)
    return lines.join("\n")
  }

  if (action === "deny_invalidated") {
    lines.push(`[Orchestrator Guard Circuit Invalidation: REPEATED_GUARD_BLOCK]`)
    lines.push(`Strategy Invalidated: This operation was blocked on previous attempt and repeated unchanged.`)
    lines.push(`\nReason: ${incident.reasonText}`)
    lines.push(`\nREQUIRED STRATEGY CHANGE:`)
    incident.suggestedActions.forEach((act, i) => {
      lines.push(`  ${i + 1}. ${act}`)
    })
    lines.push(`\nDo NOT repeat this identical command. You must choose one of the available alternatives.`)
    return lines.join("\n")
  }

  lines.push(`[Orchestrator Guard Block: ${incident.reasonCode}]`)
  lines.push(`Reason: ${incident.reasonText}`)
  lines.push(`\nAVAILABLE NEXT ACTIONS:`)
  incident.suggestedActions.forEach((act, i) => {
    lines.push(`  ${i + 1}. ${act}`)
  })
  return lines.join("\n")
}

export const orchestratorGuardStrategyCircuit = new OrchestratorGuardStrategyCircuitRegistry()
