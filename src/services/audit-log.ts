/**
 * Audit Log Service
 *
 * Append-only structured event log used by guards, supervisor, recovery,
 * and lifecycle hooks. Writes to `.codebase/AUDIT.jsonl`.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { codebaseDir } from "../tools/codebase-state"

export type AuditEventKind =
  | "guard.allow"
  | "guard.block"
  | "guard.warn"
  | "supervisor.decision"
  | "supervisor.block"
  | "supervisor.approve"
  | "recovery.action"
  | "verification.event"
  | "lifecycle.transition"
  | "routing.decision"
  | "session.started"
  | "session.completed"
  | "session.agent_verified"
  | "session.agent_mismatch"

export interface AuditEvent {
  kind: AuditEventKind
  timestamp: string
  correlation_id?: string
  level?: "debug" | "info" | "warn" | "error"
  session_id?: string
  run_id?: string
  agent?: string
  tool?: string
  decision?: string
  reason?: string
  details?: Record<string, unknown>
}

export function auditLogPath(dir: string): string {
  return join(codebaseDir(dir), "AUDIT.jsonl")
}

/**
 * Append a structured audit event. Never throws — failures are silently
 * ignored so audit logging cannot break the runtime.
 */
export function appendAuditEvent(dir: string, event: Omit<AuditEvent, "timestamp">): void {
  try {
    const cd = codebaseDir(dir)
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    const full: AuditEvent = { ...event, timestamp: new Date().toISOString() }
    appendFileSync(auditLogPath(dir), JSON.stringify(full) + "\n", "utf-8")
  } catch {
    // Audit logging is best-effort; never break the caller.
  }
}

/**
 * Redact sensitive fields from an audit event before persistence.
 * Prevents accidental exposure of credentials in structured logs.
 */
export function redactAuditData<T extends Record<string, unknown>>(event: T): T {
  const result = { ...event }
  const stringified = JSON.stringify(result)

  // Known secret patterns to redact
  const patterns: Array<[RegExp, string]> = [
    [/npm_[a-zA-Z0-9]{36,}/g, "[REDACTED_NPM_TOKEN]"],
    [/gh[psuf]_[a-zA-Z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
    [/(ghp_|gho_|ghu_|ghs_)[a-zA-Z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
  ]

  let cleaned = stringified
  for (const [pattern, replacement] of patterns) {
    cleaned = cleaned.replace(pattern, replacement)
  }

  try {
    return JSON.parse(cleaned)
  } catch {
    return result
  }
}
