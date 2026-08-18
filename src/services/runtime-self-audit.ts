/**
 * FlowDeck Runtime Self-Audit & Live Integrity Scorer (Requirements L, M, N).
 *
 * Every significant runtime action produces an independent FlowDeck self-audit
 * assessment. The score measures HOW FlowDeck itself handled the action (correctly,
 * completely, efficiently, safely) from runtime evidence — never model
 * intelligence and never model self-report.
 *
 * - Critical caps: any severe violation caps the event score regardless of the
 *   other dimensions, so averaging can never hide catastrophic failure.
 * - CURRENT HEALTH can recover after an incident.
 * - SESSION INTEGRITY retains historical degradation (monotonic incident ledger).
 * - Hidden chain-of-thought is never captured; Think events record metadata only.
 */

export type AuditDimension =
  | "execution"
  | "integrity"
  | "routing"
  | "governance"
  | "recovery"
  | "context_replay_health"
  | "completion"
  | "convergence"
  | "efficiency"
  | "state_consistency"

export type AuditCriticality = "normal" | "severe" | "fatal"

export interface AuditViolation {
  code: string;
  severity: "severe" | "fatal";
  detail: string;
  incidentId?: string;
}

export interface LatencyPhase {
  name: string;
  ms: number;
}

export interface AuditEvent {
  id: string;
  sessionID: string;
  category: string;
  operation: string;
  score: number;
  confidence: number;
  dimensions: Partial<Record<AuditDimension, number>>;
  evidenceIds: string[];
  latencyBreakdown: LatencyPhase[];
  criticalViolations: AuditViolation[];
  incidentIds: string[];
  at: number;
  /** Metadata-only representation of a Think/reasoning event — never reasoning text. */
  reasoningMeta?: {
    durationMs: number;
    terminalState?: string;
    inputTokens?: number;
    outputTokens?: number;
    toolTransition?: string;
    visibleOutputPresent: boolean;
    malformedCompletion?: boolean;
    recoveryRequired?: boolean;
  };
}

export type AuditCategory =
  | "think"
  | "fdx_search"
  | "shell"
  | "task_delegation"
  | "routing"
  | "governance"
  | "recovery"
  | "tool_execution"
  | "assistant_completion"
  | "verification"
  | "watchdog"
  | "concurrency"

const CRITICAL_CAP_SCORES: Record<string, number> = {
  WRONG_TASK_CORRELATION: 20,
  POLICY_BYPASS: 20,
  PROVIDER_REPLAY_CORRUPTION: 20,
  FALSE_DELEGATION_BLOCK: 20,
  SESSION_ANCESTRY_CORRUPTION: 25,
  RECOVERY_FLOOD: 30,
  WATCHDOG_NAG_LOOP: 30,
  NON_CONVERGENCE: 35,
  RELEASE_UNSUPPORTED: 30,
  UNSUPPORTED_RESOLUTION: 25,
  RUNTIME_CRASH: 5,
}

export interface RuntimeSelfAuditOptions {
  maxEvents?: number;
}

interface IncidentRecord {
  id: string;
  severity: "severe" | "fatal";
  code: string;
  sessionID: string;
  at: number;
}

export class RuntimeSelfAudit {
  private events: AuditEvent[] = [];
  private incidents: IncidentRecord[] = [];
  private options: Required<RuntimeSelfAuditOptions>;

  constructor(options?: RuntimeSelfAuditOptions) {
    this.options = { maxEvents: options?.maxEvents ?? 1000 };
  }

  /**
   * Score an event from runtime evidence. Never a model call.
   */
  scoreEvent(input: {
    category: AuditCategory;
    operation: string;
    sessionID: string;
    dimensionScores: Partial<Record<AuditDimension, number>>;
    evidenceIds: string[];
    latencyBreakdown: LatencyPhase[];
    violations?: AuditViolation[];
    incidentIds?: string[];
    reasoningMeta?: AuditEvent["reasoningMeta"];
    confidence?: number;
  }): AuditEvent {
    const violations = input.violations ?? [];
    const incidentIds = input.incidentIds ?? [];

    // Base score = weighted average of applicable dimensions.
    const dims = input.dimensionScores;
    const values = Object.values(dims).filter((v): v is number => typeof v === "number");
    const base = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 100;

    // Critical caps: any severe/fatal violation overrides the averaged score.
    let score = base;
    let confidence = input.confidence ?? 0.9;
    for (const v of violations) {
      if (v.severity === "fatal") {
        score = Math.min(score, CRITICAL_CAP_SCORES.RUNTIME_CRASH ?? 5);
        confidence = Math.min(confidence, 0.5);
        this.incidents.push({ id: "inc_" + Date.now() + "_" + this.incidents.length, severity: "fatal", code: v.code, sessionID: input.sessionID, at: Date.now() });
      } else if (v.severity === "severe") {
        const cap = CRITICAL_CAP_SCORES[v.code] ?? 30;
        score = Math.min(score, cap);
        this.incidents.push({ id: "inc_" + Date.now() + "_" + this.incidents.length, severity: "severe", code: v.code, sessionID: input.sessionID, at: Date.now() });
      }
    }

    const event: AuditEvent = {
      id: "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      sessionID: input.sessionID,
      category: input.category,
      operation: input.operation,
      score: Math.max(0, Math.min(100, score)),
      confidence,
      dimensions: dims,
      evidenceIds: input.evidenceIds,
      latencyBreakdown: input.latencyBreakdown,
      criticalViolations: violations,
      incidentIds,
      at: Date.now(),
      reasoningMeta: input.reasoningMeta,
    };
    this.events.push(event);
    if (this.events.length > this.options.maxEvents) this.events = this.events.slice(-this.options.maxEvents);
    return event;
  }

  /**
   * Current Health: weighted score over the recent window. Can recover.
   */
  currentHealth(sessionID?: string): { score: number; events: number } {
    const relevant = sessionID ? this.events.filter(e => e.sessionID === sessionID) : this.events;
    const recent = relevant.slice(-100);
    if (recent.length === 0) return { score: 100, events: 0 };
    const total = recent.reduce((a, e) => a + e.score, 0);
    return { score: Math.round(total / recent.length), events: recent.length };
  }

  /**
   * Session Integrity: retains historical degradation. Never recovers fully
   * while severe/fatal incidents remain on the ledger.
   */
  sessionIntegrity(sessionID?: string): { score: number; incidents: number; severeCount: number; fatalCount: number } {
    // Strictly session-scoped: an incident recorded in session A must never
    // degrade session B. When no session is given, aggregate the full ledger.
    const relevant = sessionID
      ? this.incidents.filter(i => i.sessionID === sessionID)
      : this.incidents;
    const severeCount = relevant.filter(i => i.severity === "severe").length;
    const fatalCount = relevant.filter(i => i.severity === "fatal").length;
    let base = 100;
    base -= severeCount * 15;
    base -= fatalCount * 40;
    return {
      score: Math.max(0, Math.min(100, base)),
      incidents: relevant.length,
      severeCount,
      fatalCount,
    };
  }

  /**
   * Global integrity: aggregates incidents across ALL sessions intentionally,
   * and reports the distinct sessions that hold incidents on the ledger.
   */
  globalIntegrity(): { score: number; incidents: number; severeCount: number; fatalCount: number; sessions: string[] } {
    const severeCount = this.incidents.filter(i => i.severity === "severe").length;
    const fatalCount = this.incidents.filter(i => i.severity === "fatal").length;
    let base = 100;
    base -= severeCount * 15;
    base -= fatalCount * 40;
    const sessions = [...new Set(this.incidents.map(i => i.sessionID))];
    return {
      score: Math.max(0, Math.min(100, base)),
      incidents: this.incidents.length,
      severeCount,
      fatalCount,
      sessions,
    };
  }

  /**
   * Rollups by subsystem/category.
   */
  rollups(): Record<string, { score: number; count: number }> {
    const byCat = new Map<string, number[]>();
    for (const e of this.events) {
      const arr = byCat.get(e.category) ?? [];
      arr.push(e.score);
      byCat.set(e.category, arr);
    }
    const roll: Record<string, { score: number; count: number }> = {};
    for (const [cat, scores] of byCat.entries()) {
      roll[cat] = { score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), count: scores.length };
    }
    return roll;
  }

  /**
   * Explain the factors behind a low score for an event.
   */
  explain(eventId: string): string {
    const event = this.events.find(e => e.id === eventId);
    if (!event) return "unknown event";
    const parts: string[] = [];
    for (const v of event.criticalViolations) {
      parts.push(v.code + ": " + v.detail);
    }
    for (const [dim, score] of Object.entries(event.dimensions)) {
      if (typeof score === "number" && score < 40) parts.push(dim + "=" + score);
    }
    return parts.length > 0 ? parts.join("; ") : "no critical factors";
  }

  recentEvents(sessionID?: string, limit = 20): AuditEvent[] {
    const relevant = sessionID ? this.events.filter(e => e.sessionID === sessionID) : this.events;
    return relevant.slice(-limit);
  }

  clear(): void {
    this.events = [];
  }

  clearIncidents(): void {
    this.incidents = [];
  }
}

export const runtimeSelfAudit = new RuntimeSelfAudit()

/**
 * Build a latency breakdown for a tool call (Requirement N).
 * All timings in ms. Distinguishes FlowDeck overhead from tool/runtime and
 * provider/network latency.
 */
export function buildLatencyBreakdown(phases: Array<[string, number]>): LatencyPhase[] {
  return phases.map(([name, ms]) => ({ name, ms: Math.round(ms * 100) / 100 }));
}
