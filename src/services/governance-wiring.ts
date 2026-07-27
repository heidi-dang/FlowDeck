/**
 * Governance Wiring Service
 *
 * Integrates all governance subsystem components:
 * 1. OrchestratorGuard (tool permissions per agent)
 * 2. toolGuardHook (dangerous ops, write limits, arch constraints)
 * 3. guardRailsHook (pipeline enforcement, design gates)
 * 4. loopDetector (repeated action detection)
 * 5. agent-validator (contract enforcement)
 * 6. audit-log (structured event logging)
 * 7. verification-layer (post-write verification)
 * 8. supervisor (pre-execution review)
 * 9. scorecard (empirical metrics)
 * 10. recovery-layer (bounded recovery)
 *
 * Governance modes: "off" | "advisory" | "strict"
 * - off: no enforcement, no false blocks
 * - advisory: warning and audit event only, never blocks
 * - strict: deterministic block with machine-readable reason
 * - No subsystem may independently override the resolved mode.
 */

import { loadFlowDeckConfig } from "../config/agent-models"
import type { FlowDeckConfig, GovernanceMode } from "../config/schema"
import { validateToolAccess } from "./agent-validator"
import { appendAuditEvent, type AuditEventKind } from "./audit-log"
import { verifyAfterWrite, type VerificationEvent } from "./verification-layer"

// ─── Mode resolution ───────────────────────────────────────────────────────

export function resolveGovernanceMode(directory: string): GovernanceMode {
  const config = loadFlowDeckConfig(directory)
  const mode = config.governance?.validator?.mode
  if (mode === "off" || mode === "advisory" || mode === "strict") {
    return mode
  }
  return "advisory" // default mode
}

/**
 * Resolve mode for a specific subsystem.
 * Falls back to global governance mode if subsystem mode not set.
 */
export function resolveSubsystemMode(
  config: FlowDeckConfig,
  subsystemMode?: GovernanceMode,
): GovernanceMode {
  if (subsystemMode && ["off", "advisory", "strict"].includes(subsystemMode)) {
    return subsystemMode
  }
  const globalMode = config.governance?.validator?.mode
  if (globalMode === "off" || globalMode === "advisory" || globalMode === "strict") {
    return globalMode
  }
  return "advisory"
}

// ─── Governance check mode enforcement ─────────────────────────────────────

/**
 * Check whether a governance action should proceed based on mode.
 * - off: always allow
 * - advisory: allow but return warning info
 * - strict: block when the check fails
 */
export function enforceMode(
  mode: GovernanceMode,
  checkPassed: boolean,
  warning: string,
): { action: "allow" | "warn" | "block"; reason?: string } {
  if (mode === "off") {
    return { action: "allow" }
  }
  if (checkPassed) {
    return { action: "allow" }
  }
  if (mode === "advisory") {
    return { action: "warn", reason: warning }
  }
  // strict
  return { action: "block", reason: warning }
}

// ─── Routing and recovery audit ────────────────────────────────────────────

export interface GovernanceRoutingRecord {
  directory: string
  sessionID?: string
  agent: string
  strategy: string
  details?: Record<string, unknown>
}

export function recordRoutingAudit(record: GovernanceRoutingRecord): void {
  appendAuditEvent(record.directory, {
    kind: "routing.decision",
    session_id: record.sessionID,
    agent: record.agent,
    decision: record.strategy,
    reason: `Selected execution strategy "${record.strategy}"`,
    details: record.details,
  })
}

export interface GovernanceRecoveryRecord {
  directory: string
  sessionID?: string
  agent: string
  errorKey: string
  action: "targeted_diagnosis" | "change_hypothesis" | "circuit_breaker_block"
  message: string
}

export function recordRecoveryAudit(record: GovernanceRecoveryRecord): void {
  const kind: AuditEventKind = record.action === "circuit_breaker_block" ? "guard.block" : "recovery.action"
  appendAuditEvent(record.directory, {
    kind,
    session_id: record.sessionID,
    agent: record.agent,
    decision: record.action,
    reason: record.message,
    details: { errorKey: record.errorKey },
  })
}

// ─── Tool check ────────────────────────────────────────────────────────────

export interface GovernanceCheckInput {
  directory: string
  sessionID?: string
  agent: string
  tool: string
  args?: any
}

export interface GovernanceCheckResult {
  action: "allow" | "warn" | "block"
  mode: GovernanceMode
  reason?: string
}

/**
 * Evaluate tool access against governance policy mode (off / advisory / strict).
 * Advisory mode never blocks. Strict mode blocks deterministically.
 */
export function evaluateGovernanceToolCheck(input: GovernanceCheckInput): GovernanceCheckResult {
  const mode = resolveGovernanceMode(input.directory)

  if (mode === "off") {
    appendAuditEvent(input.directory, {
      kind: "guard.allow",
      session_id: input.sessionID,
      agent: input.agent,
      tool: input.tool,
      decision: "allow",
      reason: "Governance mode is off",
    })
    return { action: "allow", mode }
  }

  const validation = validateToolAccess(input.directory, input.agent, input.tool)

  if (validation.action === "block") {
    const reason = validation.message ?? `Tool ${input.tool} blocked for agent ${input.agent}`
    appendAuditEvent(input.directory, {
      kind: "guard.block",
      session_id: input.sessionID,
      agent: input.agent,
      tool: input.tool,
      decision: "block",
      reason,
    })

    if (mode === "advisory") {
      return { action: "warn", mode, reason: `[ADVISORY] ${reason}` }
    }
    return { action: "block", mode, reason }
  }

  if (validation.action === "warn") {
    appendAuditEvent(input.directory, {
      kind: "guard.warn",
      session_id: input.sessionID,
      agent: input.agent,
      tool: input.tool,
      decision: "warn",
      reason: validation.message ?? `Tool ${input.tool} warned for agent ${input.agent}`,
    })
    if (mode === "strict") {
      return { action: "block", mode, reason: `[STRICT] ${validation.message}` }
    }
    return { action: "warn", mode, reason: validation.message }
  }

  appendAuditEvent(input.directory, {
    kind: "guard.allow",
    session_id: input.sessionID,
    agent: input.agent,
    tool: input.tool,
    decision: "allow",
    reason: "Tool check passed",
  })
  return { action: "allow", mode }
}

// ─── Post-write verification ───────────────────────────────────────────────

export function executeVerifiedPostWrite(
  directory: string,
  input: { sessionID?: string; agent?: string; tool: string; filePath?: string }
): VerificationEvent {
  const vEvent = verifyAfterWrite(directory, {
    sessionID: input.sessionID,
    agent: input.agent,
    tool: input.tool,
    filePath: input.filePath,
  })

  appendAuditEvent(directory, {
    kind: "verification.event",
    session_id: input.sessionID,
    agent: input.agent,
    tool: input.tool,
    decision: vEvent.status,
    reason: vEvent.findings.join("; ") || `Verification ${vEvent.status}`,
    details: { checks: vEvent.checks, findings: vEvent.findings, filePath: input.filePath },
  })

  return vEvent
}

// ─── Scorecard generation ──────────────────────────────────────────────────

export interface ScorecardData {
  commandsRun: number
  testsPassed: number | null
  testsFailed: number | null
  buildResult: "pass" | "fail" | "not_run" | null
  typecheckResult: "pass" | "fail" | "not_run" | null
  filesChanged: number | null
  toolCalls: number
  delegations: number
  retries: number
  blocks: number
  warnings: number
  durationMs: number | null
  tokensUsed?: number
  estimatedCostUSD?: number
  remainingFindings: number | null
}

export function generateScorecard(data: ScorecardData): Record<string, unknown> {
  // Determine "passed" status with strict null handling:
  // - null when results are unknown (not yet run)
  // - true only when there's actual evidence that everything passed
  let passed: boolean | null
  const evidenceOfFailure = data.testsFailed !== null && data.testsFailed > 0
  const evidenceOfBuildFail = data.buildResult === "fail"
  const evidenceOfTypecheckFail = data.typecheckResult === "fail"
  const evidenceOfFindings = data.remainingFindings !== null && data.remainingFindings > 0

  if (evidenceOfFailure || evidenceOfBuildFail || evidenceOfTypecheckFail || evidenceOfFindings) {
    passed = false
  } else {
    const hasAnyEvidence = data.testsPassed !== null || data.testsFailed !== null ||
      data.buildResult !== null || data.typecheckResult !== null || data.remainingFindings !== null
    if (hasAnyEvidence) {
      // Some results known and none indicate failure
      passed = true
    } else {
      // All results unknown — not enough evidence to determine pass/fail
      passed = null
    }
  }

  return {
    timestamp: new Date().toISOString(),
    commands_run: data.commandsRun,
    tests_passed: data.testsPassed,
    tests_failed: data.testsFailed,
    build_result: data.buildResult,
    typecheck_result: data.typecheckResult,
    files_changed: data.filesChanged,
    tool_calls: data.toolCalls,
    delegations: data.delegations,
    retries: data.retries,
    blocks: data.blocks,
    warnings: data.warnings,
    duration_ms: data.durationMs,
    tokens_used: data.tokensUsed,
    estimated_cost_usd: data.estimatedCostUSD,
    remaining_findings: data.remainingFindings,
    passed,
  }
}

// ─── Delegation depth enforcement ──────────────────────────────────────────

/**
 * Verify delegation depth is valid.
 * maxDepth is configurable (default 1). Specialists cannot delegate.
 * Heidi cannot delegate to itself.
 */
export function validateDelegationDepth(
  delegatingAgent: string,
  targetAgent: string,
  currentDepth: number,
  specialistAgents: Set<string>,
  maxDepth: number = 1,
): { allowed: boolean; reason?: string } {
  // Specialists cannot delegate
  if (specialistAgents.has(delegatingAgent)) {
    return { allowed: false, reason: `Specialist agent "${delegatingAgent}" cannot delegate — only Heidi may delegate.` }
  }

  // Heidi cannot delegate to itself
  if (delegatingAgent === targetAgent) {
    return { allowed: false, reason: `Heidi cannot delegate to itself. Execute directly or delegate to a different agent.` }
  }

  // Depth limit (capped at maxDepth from config)
  if (currentDepth >= maxDepth) {
    return { allowed: false, reason: `Maximum delegation depth of ${maxDepth} exceeded (current: ${currentDepth}). Use direct execution or escalate to user.` }
  }

  return { allowed: true }
}
