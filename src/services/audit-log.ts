/**
 * Audit Log Service
 *
 * Append-only structured event log used by guards, supervisor, recovery,
 * and lifecycle hooks. Writes to `.codebase/AUDIT.jsonl`.
 *
 * Fast Harness v1 — hot-path persistence:
 *  - Non-critical informational events (guard.allow, routing.decision, ...)
 *    are buffered in a bounded queue and flushed periodically or on size
 *    threshold. They never block a safe read on the hot path.
 *  - Critical events (guard.block, policy violations, destructive-operation
 *    blocks, fatal/recovery exhaustion, critical security events) flush
 *    synchronously so safety decisions are never lost for speed.
 *  - Bounded queue, periodic/size flush, dispose flush, secret redaction
 *    preserved, no recursive logging failure.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { codebaseDir } from "../tools/codebase-state"
import { redactSecrets } from "../lib/secret-redaction"

export type AuditEventKind =
  | "guard.allow"
  | "guard.block"
  | "guard.warn"
  | "approval.required"
  | "approval.granted"
  | "approval.denied"
  | "approval.consumed"
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
  | "delegation.started"
  | "delegation.completed"
  | "delegation.failed"
  | "delegation.blocked"
  | "loop_guard.blocked"
  | "self_audit.event"
  | "convergence.guard"
  | "watchdog.action"
  | "lease.acquired"
  | "lease.conflict"
  | "tool_fast_lane.rewrite"
  | "empty_terminal.recovery"

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

/** Event kinds that MUST be durable immediately (safety-critical). */
const CRITICAL_KINDS: ReadonlySet<string> = new Set([
  "guard.block",
  "guard.warn",
  "approval.required",
  "approval.granted",
  "approval.denied",
  "approval.consumed",
  "supervisor.block",
  "recovery.action",
  "session.agent_mismatch",
  "delegation.failed",
  "delegation.blocked",
  "delegation.started",
  "delegation.completed",
])



function isCriticalEvent(event: AuditEvent): boolean {
  if (CRITICAL_KINDS.has(event.kind)) return true
  if (event.level === "warn" || event.level === "error") return true
  return false
}

interface PendingAuditWrite {
  dir: string
  line: string
}

// ─── Bounded buffer ────────────────────────────────────────────────────────

const MAX_BUFFERED_EVENTS = 200
const FLUSH_SIZE_THRESHOLD = 100
const FLUSH_PERIOD_MS = 2_500

let _buffer: PendingAuditWrite[] = []
let _flushTimer: ReturnType<typeof setInterval> | null = null
let _exitHandlersInstalled = false

function ensureTimer(): void {
  if (_flushTimer) return
  _flushTimer = setInterval(() => {
    try { flushAuditBuffer() } catch { /* never break the runtime */ }
  }, FLUSH_PERIOD_MS)
  // Never hold the process open just for audit flushing.
  if (typeof _flushTimer.unref === "function") _flushTimer.unref()
}

function installExitHandlers(): void {
  if (_exitHandlersInstalled) return
  _exitHandlersInstalled = true
  process.once("beforeExit", () => { try { flushAuditBuffer() } catch { /* best-effort */ } })
  process.once("exit", () => { try { flushAuditBufferSync() } catch { /* best-effort */ } })
}

function writeLineSync(dir: string, line: string): void {
  const cd = codebaseDir(dir)
  if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
  appendFileSync(auditLogPath(dir), line + "\n", "utf-8")
}

/**
 * Flush all buffered non-critical events. Async-safe (no throw on failure).
 * Exported so callers can flush deterministically (e.g. dispose/session end).
 */
export function flushAuditBuffer(): void {
  if (_buffer.length === 0) return
  const pending = _buffer
  _buffer = []
  for (const item of pending) {
    try { writeLineSync(item.dir, item.line) } catch { /* best-effort, never throw */ }
  }
}

/** Synchronous variant for process exit handlers. */
function flushAuditBufferSync(): void {
  flushAuditBuffer()
}

/** Number of events currently buffered (observability/tests). */
export function bufferedAuditCount(): number {
  return _buffer.length
}

/** Drop all buffered events without writing (tests only). */
export function resetAuditBufferForTests(): void {
  _buffer = []
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = null
  }
}

/**
 * Append a structured audit event. Never throws — failures are silently
 * ignored so audit logging cannot break the runtime.
 *
 * Critical events (blocks, policy violations, destructive-operation guards,
 * fatal/recovery exhaustion, security mismatches) are written synchronously.
 * Non-critical informational events are buffered and flushed periodically,
 * on size threshold, or on dispose/exit.
 */
export function appendAuditEvent(dir: string, event: Omit<AuditEvent, "timestamp">): void {
  try {
    const full: AuditEvent = { ...event, timestamp: new Date().toISOString() }
    const line = redactSecrets(JSON.stringify(full))
    if (isCriticalEvent(full)) {
      // Critical: flush any pending buffer first (order preserved), then write synchronously.
      try { flushAuditBuffer() } catch { /* best-effort */ }
      writeLineSync(dir, line)
      return
    }
    // Non-critical: buffer (bounded) and schedule periodic flush.
    if (_buffer.length >= MAX_BUFFERED_EVENTS) {
      // Bounded queue: force a flush rather than dropping events.
      try { flushAuditBuffer() } catch { /* best-effort */ }
    }
    _buffer.push({ dir, line })
    if (_buffer.length >= FLUSH_SIZE_THRESHOLD) {
      try { flushAuditBuffer() } catch { /* best-effort */ }
    } else {
      ensureTimer()
      installExitHandlers()
    }
  } catch {
    // Audit logging is best-effort; never break the caller.
  }
}
