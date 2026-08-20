/**
 * Orchestrator Guard Strategy Circuit (FlowDeck v2.2.7)
 *
 * Implements an authoritative strategy tracker and circuit breaker for guard decisions:
 *   - ALLOW: Records allowed progress and clears invalidated fingerprints on state mutation.
 *   - APPROVAL_REQUIRED / WAITING_FOR_APPROVAL: Tracks pending approval state without churning
 *     failure retry counters or tripping loop suppression.
 *   - DENY_INVALID / INVALIDATED: Bounds identical unchanged retries (Attempt 1 recoverable ->
 *     Attempt 2 terminal invalidation -> Attempt 3+ suppressed).
 */

export interface BlockedStrategyIncident {
  fingerprint: string
  sessionID: string
  firstBlockedAt: number
  lastBlockedAt: number
  repeatCount: number
  strategyGeneration: number
  status: "active" | "approval_pending" | "approved" | "denied" | "invalidated" | "suppressed"
  reasonCode: string
  reasonText: string
  suggestedActions: string[]
  repoGeneration?: string
}

export interface CircuitEvaluation {
  action: "deny" | "deny_invalidated" | "suppressed" | "approval_required" | "approval_pending" | "denied"
  repeatCount: number
  incident: BlockedStrategyIncident
  message: string
}

export function normalizeGuardFingerprint(toolName: string, input: unknown, cwd?: string): string {
  const tool = (toolName || "tool").toLowerCase().trim()
  let normalizedArgs = ""
  let effectiveCwd = cwd ? cwd.trim().toLowerCase() : ""

  if (typeof input === "string") {
    normalizedArgs = normalizeCommandString(input)
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    if (typeof obj.cwd === "string" && !effectiveCwd) {
      effectiveCwd = obj.cwd.trim().toLowerCase()
    }
    if (typeof obj.command === "string") {
      normalizedArgs = normalizeCommandString(obj.command)
    } else if (typeof obj.file === "string" || typeof obj.file_path === "string" || typeof obj.filePath === "string") {
      normalizedArgs = String(obj.file || obj.file_path || obj.filePath || "").trim().toLowerCase()
    } else {
      normalizedArgs = JSON.stringify(obj, Object.keys(obj).sort())
    }
  }

  const cwdPart = effectiveCwd ? `[cwd:${effectiveCwd}]` : ""
  return `${tool}:${normalizedArgs}${cwdPart}`
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

const _toolErrorCounts = new Map<string, number>()
export const TOOL_ERROR_HARD_LIMIT = 2
const MAX_ERROR_COUNT_ENTRIES = 2000

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

export class OrchestratorGuardStrategyCircuitRegistry {
  private incidents = new Map<string, BlockedStrategyIncident>()
  private sessionGenerations = new Map<string, number>()
  private lastRepoGenerations = new Map<string, string>()

  evaluateBlock(params: {
    sessionID: string
    toolName: string
    input: unknown
    reasonCode: string
    reasonText: string
    suggestedActions?: string[]
    repoGeneration?: string
    cwd?: string
    isApprovalRequired?: boolean
  }): CircuitEvaluation {
    const { sessionID, toolName, input, reasonCode, reasonText, suggestedActions = [], repoGeneration, cwd, isApprovalRequired } = params
    const fingerprint = normalizeGuardFingerprint(toolName, input, cwd)
    const key = `${sessionID}:${fingerprint}`
    const now = Date.now()

    let currentGen = this.sessionGenerations.get(sessionID) ?? 1
    const lastRepoGen = this.lastRepoGenerations.get(sessionID)

    if (repoGeneration && lastRepoGen && repoGeneration !== lastRepoGen) {
      currentGen++
      this.sessionGenerations.set(sessionID, currentGen)
      this.lastRepoGenerations.set(sessionID, repoGeneration)
      this.incidents.delete(key)
    } else if (repoGeneration && !lastRepoGen) {
      this.lastRepoGenerations.set(sessionID, repoGeneration)
    }

    const existing = this.incidents.get(key)

    if (!existing || existing.strategyGeneration !== currentGen) {
      const incident: BlockedStrategyIncident = {
        fingerprint,
        sessionID,
        firstBlockedAt: now,
        lastBlockedAt: now,
        repeatCount: 1,
        strategyGeneration: currentGen,
        status: isApprovalRequired ? "approval_pending" : "active",
        reasonCode,
        reasonText,
        suggestedActions,
        repoGeneration,
      }
      this.incidents.set(key, incident)

      if (isApprovalRequired) {
        return {
          action: "approval_required",
          repeatCount: 1,
          incident,
          message: `[FlowDeck Guard] Action requires explicit User Approval: ${reasonText}`,
        }
      }

      return {
        action: "deny",
        repeatCount: 1,
        incident,
        message: `[FlowDeck Guard] Blocked execution attempt 1. Action is recoverable: replan with specialist routing or read-only tools.`,
      }
    }

    existing.lastBlockedAt = now

    if (isApprovalRequired) {
      existing.status = "approval_pending"
      return {
        action: "approval_pending",
        repeatCount: existing.repeatCount,
        incident: existing,
        message: `[FlowDeck Guard] Action is currently WAITING_FOR_APPROVAL. Please grant approval in the FlowDeck UI before retrying.`,
      }
    }

    existing.repeatCount++

    if (existing.repeatCount === 2) {
      existing.status = "invalidated"
      return {
        action: "deny_invalidated",
        repeatCount: 2,
        incident: existing,
        message: `[FlowDeck Guard - STRATEGY INVALIDATED] Heidi attempted the exact same blocked action (${toolName}) twice in generation ${currentGen} without state transition. Hard stop to prevent retry loop.`,
      }
    }

    existing.status = "suppressed"
    return {
      action: "suppressed",
      repeatCount: existing.repeatCount,
      incident: existing,
      message: `[FlowDeck Guard - LOOP SUPPRESSED] Repeated unchanged blocked action (${toolName}) suppressed (${existing.repeatCount} attempts).`,
    }
  }

  recordAllowedProgress(sessionID: string, newRepoGeneration?: string): void {
    const currentGen = (this.sessionGenerations.get(sessionID) ?? 1) + 1
    this.sessionGenerations.set(sessionID, currentGen)
    if (newRepoGeneration) {
      this.lastRepoGenerations.set(sessionID, newRepoGeneration)
    }

    for (const [key, incident] of this.incidents.entries()) {
      if (incident.sessionID === sessionID) {
        this.incidents.delete(key)
      }
    }
  }

  clearSession(sessionID: string): void {
    this.sessionGenerations.delete(sessionID)
    this.lastRepoGenerations.delete(sessionID)
    for (const [key, incident] of this.incidents.entries()) {
      if (incident.sessionID === sessionID) {
        this.incidents.delete(key)
      }
    }
  }

  clearAll(): void {
    this.incidents.clear()
    this.sessionGenerations.clear()
    this.lastRepoGenerations.clear()
    _toolErrorCounts.clear()
  }
}

export const orchestratorGuardStrategyCircuit = new OrchestratorGuardStrategyCircuitRegistry()
