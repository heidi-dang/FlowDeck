/**
 * Governance Wiring Service
 *
 * Integrates all 7 governance subsystem components:
 * 1. OrchestratorGuard
 * 2. toolGuardHook
 * 3. guardRailsHook
 * 4. loopDetector
 * 5. agent-validator
 * 6. audit-log
 * 7. verification-layer
 *
 * Supports governance modes: "off" | "advisory" | "strict".
 */

import { loadFlowDeckConfig } from "../config/agent-models"
import { validateToolAccess } from "./agent-validator"
import { appendAuditEvent, type AuditEventKind } from "./audit-log"
import { verifyAfterWrite, type VerificationEvent } from "./verification-layer"

export type GovernanceMode = "off" | "advisory" | "strict"

export function resolveGovernanceMode(directory: string): GovernanceMode {
  const config = loadFlowDeckConfig(directory)
  const mode = config.governance?.validator?.mode
  if (mode === "off" || mode === "advisory" || mode === "strict") {
    return mode
  }
  return "advisory" // default mode
}

export interface GovernanceRoutingRecord {
  directory: string
  sessionID?: string
  agent: string
  strategy: string
  details?: Record<string, unknown>
}

/**
 * Record strategy selection and routing decisions in audit log.
 */
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

/**
 * Record bounded recovery actions in audit log.
 */
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
    appendAuditEvent(input.directory, {
      kind: "guard.block",
      session_id: input.sessionID,
      agent: input.agent,
      tool: input.tool,
      decision: "block",
      reason: validation.message ?? `Tool ${input.tool} blocked for agent ${input.agent}`,
    })
    return {
      action: "block",
      mode,
      reason: validation.message ?? `Tool ${input.tool} blocked for agent ${input.agent}`,
    }
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
    return {
      action: "warn",
      mode,
      reason: validation.message,
    }
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

/**
 * Run post-write verification and record structured audit event.
 */
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
