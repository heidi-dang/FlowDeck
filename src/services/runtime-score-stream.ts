/**
 * Runtime Integrity Score Stream — UI-safe runtime scores (Roadmap items 1-15).
 *
 * Runtime hooks -> RuntimeSelfAudit -> RuntimeScoreEvent -> (telemetry + WebUI).
 * The score is determined by runtime evidence ONLY — Heidi never chooses a percentage.
 * Only UI-safe fields cross the presentation boundary: no hidden CoT, no reasoning text,
 * no secrets, no raw system prompts, no private scratchpad.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { runtimeSelfAudit, type AuditEvent } from "./runtime-self-audit"

export type UIReasonCode =
  | "WRONG_TASK_CORRELATION"
  | "PROVIDER_REPLAY_CORRUPTION"
  | "POLICY_BYPASS"
  | "RUNTIME_CRASH"
  | "SESSION_ANCESTRY_CORRUPTION"
  | "RECOVERY_FLOOD"
  | "WATCHDOG_NAG_LOOP"
  | "NON_CONVERGENCE"
  | "UNSUPPORTED_RESOLUTION"
  | "INCOMPLETE_FANOUT"
  | "COORDINATOR_IDLE"
  | "COORDINATOR_IDLE_WHILE_CHILDREN_ACTIVE"
  | "AWAIT_ALL_BEFORE_CONVERGENCE"
  | "MISSED_READY_CHILD_RESULT"
  | "REPEATED_GUARD_BLOCK"
  | "STRATEGY_NOT_INVALIDATED"
  | "READY_NOT_REVIEWED"
  | "LOOP_GUARD_FLOOD"
  | "REPLAY_SAFE"
  | "COMPLETION_EVIDENCE_OK"

export interface RuntimeScoreReason {
  code: UIReasonCode
  detail: string
  kind: "cap" | "warning" | "info";
}

export interface RuntimeIntegrityScore {
  eventId: string;
  actionClass: string;
  label: string;
  sessionId: string;
  /** Stable operation lifecycle status (started/completed/failed/cancelled). */
  status?: "started" | "completed" | "failed" | "cancelled";
  /** Process exit code captured on a failed operation. */
  exitCode?: number;
  /** Short, safe (redacted) stderr summary. */
  stderrSummary?: string;
  /** The originating OpenCode tool call ID. */
  toolCallId?: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  currentHealth: number;
  sessionIntegrity: number;
  dimensions: Partial<Record<string, number>>;
  reasons: RuntimeScoreReason[];
  at: number;
}

/**
 * Centralized, documented critical-score caps. Severe failures are never averaged away.
 * These are the authoritative caps the WebUI displays — the WebUI never calculates them.
 */
export const UI_SCORE_CAPS: Record<string, number> = {
  WRONG_TASK_CORRELATION: 40,
  PROVIDER_REPLAY_CORRUPTION: 30,
  POLICY_BYPASS: 20,
  RUNTIME_CRASH: 10,
  SESSION_ANCESTRY_CORRUPTION: 25,
  UNSUPPORTED_RESOLUTION: 25,
  RECOVERY_FLOOD: 30,
  WATCHDOG_NAG_LOOP: 30,
  NON_CONVERGENCE: 35,
  INCOMPLETE_FANOUT: 45,
  LOOP_GUARD_FLOOD: 55,
  COORDINATOR_IDLE_WHILE_CHILDREN_ACTIVE: 40,
  AWAIT_ALL_BEFORE_CONVERGENCE: 45,
  MISSED_READY_CHILD_RESULT: 45,
  REPEATED_GUARD_BLOCK: 50,
  STRATEGY_NOT_INVALIDATED: 50,
}

const REASON_DETAILS: Record<string, string> = {
  WRONG_TASK_CORRELATION: "wrong task/session correlation",
  PROVIDER_REPLAY_CORRUPTION: "invalid provider replay",
  POLICY_BYPASS: "policy bypass",
  RUNTIME_CRASH: "runtime crash",
  SESSION_ANCESTRY_CORRUPTION: "root delegation ancestry corrupted",
  UNSUPPORTED_RESOLUTION: "unsupported completion claim",
  RECOVERY_FLOOD: "recovery flood",
  WATCHDOG_NAG_LOOP: "watchdog nag loop",
  NON_CONVERGENCE: "task did not converge",
  INCOMPLETE_FANOUT: "intended parallel fan-out incomplete",
  COORDINATOR_IDLE: "root coordinator idle while children active",
  COORDINATOR_IDLE_WHILE_CHILDREN_ACTIVE: "coordinator idle while children active",
  AWAIT_ALL_BEFORE_CONVERGENCE: "await-all barrier blocked incremental integration before convergence",
  MISSED_READY_CHILD_RESULT: "missed ready child result left unintegrated",
  REPEATED_GUARD_BLOCK: "repeated guard blocks encountered",
  STRATEGY_NOT_INVALIDATED: "strategy not invalidated upon contract change",
  READY_NOT_REVIEWED: "ready result was not reviewed",
  LOOP_GUARD_FLOOD: "repeated recoverable blocks",
  REPLAY_SAFE: "provider replay sanitation safe",
  COMPLETION_EVIDENCE_OK: "completion evidence gate passed",
}

export function accessibleScoreLabel(score: number): string {
  return "FlowDeck runtime integrity: " + Math.round(score) + " percent";
}

export function scoreBadgeText(score: number): string {
  return "FlowDeck " + Math.round(score) + "%";
}

export function auditToUiScore(audit: AuditEvent, health: { currentHealth: number; sessionIntegrity: number }): RuntimeIntegrityScore {
  const reasons: RuntimeScoreReason[] = [];
  let score = audit.score;
  let confidence = audit.confidence;
  for (const v of audit.criticalViolations) {
    const detail = REASON_DETAILS[v.code] ?? v.code;
    reasons.push({ code: v.code as UIReasonCode, detail, kind: v.severity === "fatal" ? "cap" : "warning" });
    const cap = UI_SCORE_CAPS[v.code];
    if (typeof cap === "number") { score = Math.min(score, cap); confidence = Math.min(confidence, 0.5) }
  }
  if (audit.evidenceIds.length > 0 && reasons.length === 0) {
    reasons.push({ code: "COMPLETION_EVIDENCE_OK", detail: REASON_DETAILS.COMPLETION_EVIDENCE_OK, kind: "info" });
  }
  return {
    eventId: audit.id,
    actionClass: actionClassForCategory(audit.category),
    label: audit.operation,
    sessionId: audit.sessionID,
    status: audit.status,
    exitCode: audit.exitCode,
    stderrSummary: audit.stderrSummary,
    toolCallId: audit.toolCallId,
    score: Math.max(0, Math.min(100, Math.round(score))),
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceCount: audit.evidenceIds.length + audit.incidentIds.length,
    currentHealth: health.currentHealth,
    sessionIntegrity: health.sessionIntegrity,
    dimensions: audit.dimensions as Partial<Record<string, number>>,
    reasons,
    at: audit.at,
  };
}

function actionClassForCategory(category: string): string {
  switch (category) {
    case "fdx_search": return "FDX";
    case "shell": return "Shell";
    case "task_delegation": return "Task";
    case "parallel_coordination": return "Parallel Coordination";
    case "assistant_completion": return "Chat";
    case "think": return "Think";
    case "recovery": return "Recovery";
    case "watchdog": return "Watchdog";
    case "verification": return "Verification";
    case "routing": return "Routing";
    default: return "Tool";
  }
}

export interface SessionHealth {
  currentHealth: number;
  sessionIntegrity: number;
  currentHealthEvents: number;
}

export interface ScoreExplanation {
  eventId: string;
  dimensions: Record<string, number>;
  reasons: RuntimeScoreReason[];
  evidenceCount: number;
  confidence: string;
  accessibleLabel: string;
}

export class RuntimeScoreboard {
  private readonly ledgerPath: string;
  private readonly maxEntries: number;
  private readonly scores = new Map<string, RuntimeIntegrityScore>();
  private order: string[] = [];
  private loaded = false;
  private detach: (() => void) | null = null;

  constructor(directory: string, maxEntries = 2000) {
    this.ledgerPath = join2(directory, ".flowdeck", "scores.jsonl");
    this.maxEntries = maxEntries;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.ledgerPath)) {
        const lines = readFileSync(this.ledgerPath, "utf8").split("\n").filter((l) => l.trim());
        const keep = lines.slice(-this.maxEntries);
        for (const line of keep) {
          try {
            const o = JSON.parse(line);
            if (o && typeof o.eventId === "string") {
              // One row per operation: later events with the same eventId update
              // the same row in place (terminal replaces provisional), never a
              // second/duplicate order entry.
              this.scores.set(o.eventId, o);
              this.order = this.order.filter((id) => id !== o.eventId);
              this.order.push(o.eventId);
            }
          } catch {}
        }
      }
    } catch { /* best-effort */ }
  }

  attach(): () => void {
    if (!this.detach) {
      this.detach = runtimeSelfAudit.onScoreEvent((audit) => {
        const ch = runtimeSelfAudit.currentHealth(audit.sessionID);
        const si = runtimeSelfAudit.sessionIntegrity(audit.sessionID);
        this.ingest(auditToUiScore(audit, { currentHealth: ch.score, sessionIntegrity: si.score }));
      });
    }
    return this.detach;
  }

  ingest(score: RuntimeIntegrityScore): void {
    this.ensureLoaded();
    this.scores.set(score.eventId, score);
    this.order = this.order.filter((id) => id !== score.eventId);
    this.order.push(score.eventId);
    if (this.order.length > this.maxEntries) { const drop = this.order.shift()!; this.scores.delete(drop) }
    this.persistAppend(score);
  }

  update(eventId: string, patch: Partial<RuntimeIntegrityScore>): RuntimeIntegrityScore | null {
    this.ensureLoaded();
    const existing = this.scores.get(eventId);
    if (!existing) return null;
    const next = { ...existing, ...patch, at: Date.now() };
    this.scores.set(eventId, next);
    this.persistAppend(next);
    return next;
  }

  get(eventId: string): RuntimeIntegrityScore | undefined { this.ensureLoaded(); return this.scores.get(eventId) }

  list(sessionId?: string, limit = 100): RuntimeIntegrityScore[] {
    this.ensureLoaded();
    const ids = sessionId ? this.order.filter((id) => this.scores.get(id)!.sessionId === sessionId) : this.order.slice();
    return ids.slice(-limit).reverse().map((id) => this.scores.get(id)!);
  }

  sessionHealth(sessionId?: string): SessionHealth {
    this.ensureLoaded();
    const ch = sessionId ? runtimeSelfAudit.currentHealth(sessionId) : runtimeSelfAudit.currentHealth();
    const si = sessionId ? runtimeSelfAudit.sessionIntegrity(sessionId) : runtimeSelfAudit.sessionIntegrity();
    if (ch.events === 0 && this.scores.size > 0) {
      const relevant = sessionId ? this.list(sessionId) : this.list();
      if (relevant.length > 0) {
        const avg = Math.round(relevant.reduce((a, s) => a + s.score, 0) / relevant.length);
        return { currentHealth: avg, sessionIntegrity: si.score === 100 && avg < 100 ? avg : si.score, currentHealthEvents: relevant.length };
      }
    }
    return { currentHealth: ch.score, sessionIntegrity: si.score, currentHealthEvents: ch.events };
  }

  explanation(eventId: string): ScoreExplanation | null {
    const s = this.get(eventId);
    if (!s) return null;
    const dims: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.dimensions)) if (typeof v === "number") dims[k] = v;
    return { eventId: s.eventId, dimensions: dims, reasons: s.reasons, evidenceCount: s.evidenceCount, confidence: s.confidence > 0.8 ? "high" : s.confidence > 0.5 ? "medium" : "low", accessibleLabel: accessibleScoreLabel(s.score) };
  }

  private persistAppend(score: RuntimeIntegrityScore): void {
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      writeFileSync(this.ledgerPath, JSON.stringify(score) + "\n", { flag: "a" });
    } catch { /* persistence must never break runtime */ }
  }

  clearSession(sessionId?: string): void {
    if (sessionId) { for (const id of this.order) if (this.scores.get(id)!.sessionId === sessionId) this.scores.delete(id); this.order = this.order.filter((id) => this.scores.has(id)) }
    else { this.scores.clear(); this.order = [] }
  }
}

function join2(a: string, b: string, c: string): string { return a.replace(/\\+$/, "") + "/" + b + "/" + c }

const registry = new Map<string, RuntimeScoreboard>();

export function getScoreboardFor(directory: string): RuntimeScoreboard {
  let sb = registry.get(directory);
  if (!sb) { sb = new RuntimeScoreboard(directory); registry.set(directory, sb); }
  return sb;
}

export function clearScoreboardFor(directory: string): void { registry.delete(directory) }

export function renderScoreBadgeHtml(score: number): string {
  const s = Math.round(score);
  const cls = s >= 90 ? "fd-score-good" : s >= 70 ? "fd-score-ok" : s >= 50 ? "fd-score-fair" : "fd-score-poor";
  return "<span class=\"fd-score-row\"><span class=\"fd-score-badge " + cls + "\" title=\"" + accessibleScoreLabel(s) + "\">FlowDeck " + s + "%</span></span>";
}

export function renderSessionHealthHtml(health: SessionHealth): string {
  const ch = "<strong aria-label=\"FlowDeck current health: " + health.currentHealth + " percent\">" + health.currentHealth + "%</strong>";
  const si = "<strong aria-label=\"FlowDeck session integrity: " + health.sessionIntegrity + " percent\">" + health.sessionIntegrity + "%</strong>";
  return "<section class=\"fd-health\" aria-label=\"FlowDeck session health\"><h2>FlowDeck</h2><p>Current Health " + ch + "</p><p>Session Integrity " + si + "</p></section>";
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * WebUI action-row label for a RuntimeIntegrityScore. Shows the terminal status
 * as visible text (not color-only) with an accessible exit code and an
 * expandable, escaped stderr summary for failed operations.
 */
export function renderActionLabelHtml(s: RuntimeIntegrityScore): string {
  const cls = escapeHtml(s.actionClass || "Tool")
  const label = escapeHtml(s.label || "")
  let text = cls + " " + label
  if (s.status === "failed") {
    text += " \u2014 Failed" + (typeof s.exitCode === "number" ? " \u00b7 exit " + s.exitCode : "")
  }
  const aria = "aria-label=\"" + text + ". " + accessibleScoreLabel(s.score) + "\""
  const detail =
    s.status === "failed" && s.stderrSummary
      ? "<details class=\"fd-error-detail\" tabindex=\"0\"><summary>stderr</summary><pre>" + escapeHtml(s.stderrSummary) + "</pre></details>"
      : ""
  return "<span class=\"fd-action-label\" " + aria + ">" + text + "</span>" + detail
}

export function renderExplanationHtml(ex: ScoreExplanation): string {
  const dimRows = Object.entries(ex.dimensions).map(([k, v]) => "<li><span>" + k + "</span><strong>" + v + "</strong></li>").join("");
  const reasonRows = ex.reasons.map((r) => "<li><code>" + r.code + "</code> — " + r.detail + "</li>").join("");
  return "<div class=\"fd-explanation\" tabindex=\"0\" aria-label=\"" + ex.accessibleLabel + "\"><ul>" + dimRows + "</ul><ul class=\"fd-reasons\">" + reasonRows + "</ul><p>Evidence: " + ex.evidenceCount + " events · Confidence: " + ex.confidence + "</p></div>";
}
