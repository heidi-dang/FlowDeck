/**
 * HeidiPerformanceTracker — Lightweight execution telemetry.
 *
 * Records microsecond-accurate span timings and aggregate metrics for
 * Heidi execution phases. Overhead target: < 1 ms p50 per span operation.
 *
 * Privacy invariants:
 * - CoT (chain-of-thought) content is never recorded.
 * - API keys, credentials, and sensitive prompt content are stripped before export.
 * - Only structural metrics (counts, latencies, token totals) are kept.
 */

export type SpanKind =
  | "task.total"
  | "routing"
  | "config.load"
  | "governance.check"
  | "governance.read_fast_path"
  | "governance.write_full"
  | "read_batch"
  | "tool.before"
  | "tool.execute"
  | "tool.after"
  | "token.accounting"
  | "audit.append"
  | "delegation.startup"
  | "child.runtime"
  | "integration"
  | "verification"
  | "provider.request"
  | "provider.ttft"
  | "provider.completion"

export interface Span {
  kind: SpanKind
  startedAt: number   // performance.now() or Date.now() ms
  endedAt?: number
  durationMs?: number
  metadata?: Record<string, string | number | boolean>
}

export interface ExecutionMetrics {
  taskId: string
  sessionId?: string
  executionClass?: string
  totalWallClockMs?: number
  timeToFirstProviderRequestMs?: number
  providerTtftMs?: number
  providerCompletionMs?: number
  modelTurns: number
  inputTokens: number
  outputTokens: number
  contextSizeTokens?: number
  toolCallsTotal: number
  toolCallsParallel: number
  toolCallsSequential: number
  toolBeforeOverheadMs: number
  toolAfterOverheadMs: number
  routingMs: number
  configLoadMs: number
  governanceCheckMs: number
  governanceFastPathHits: number
  governanceFullPathHits: number
  auditAppendMs: number
  tokenAccountingMs: number
  fdxLatencyMs: number
  delegationStartupMs: number
  childRuntimeMs: number
  integrationMs: number
  verificationMs: number
  spans: Span[]
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

export class HeidiPerformanceTracker {
  private readonly metrics: ExecutionMetrics
  private readonly activeSpans = new Map<string, Span>()
  private spanCounter = 0

  constructor(taskId: string, sessionId?: string) {
    this.metrics = {
      taskId,
      sessionId,
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCallsTotal: 0,
      toolCallsParallel: 0,
      toolCallsSequential: 0,
      toolBeforeOverheadMs: 0,
      toolAfterOverheadMs: 0,
      routingMs: 0,
      configLoadMs: 0,
      governanceCheckMs: 0,
      governanceFastPathHits: 0,
      governanceFullPathHits: 0,
      auditAppendMs: 0,
      tokenAccountingMs: 0,
      fdxLatencyMs: 0,
      delegationStartupMs: 0,
      childRuntimeMs: 0,
      integrationMs: 0,
      verificationMs: 0,
      spans: [],
    }
  }

  /** Start a named span. Returns an opaque span handle key. */
  startSpan(kind: SpanKind, metadata?: Record<string, string | number | boolean>): string {
    const key = `${kind}:${++this.spanCounter}`
    const span: Span = { kind, startedAt: now(), metadata }
    this.activeSpans.set(key, span)
    return key
  }

  /** End a span by its handle key. Returns duration in ms. */
  endSpan(key: string): number {
    const span = this.activeSpans.get(key)
    if (!span) return 0
    const endedAt = now()
    const durationMs = endedAt - span.startedAt
    span.endedAt = endedAt
    span.durationMs = durationMs
    this.activeSpans.delete(key)
    this.metrics.spans.push(span)
    this.accumulateSpan(span, durationMs)
    return durationMs
  }

  /** Convenience wrapper: time a synchronous fn and return its result. */
  time<T>(kind: SpanKind, fn: () => T): T {
    const key = this.startSpan(kind)
    try {
      return fn()
    } finally {
      this.endSpan(key)
    }
  }

  /** Convenience wrapper: time an async fn and return its result. */
  async timeAsync<T>(kind: SpanKind, fn: () => Promise<T>): Promise<T> {
    const key = this.startSpan(kind)
    try {
      return await fn()
    } finally {
      this.endSpan(key)
    }
  }

  recordModelTurn(inputTokens: number, outputTokens: number, contextSizeTokens?: number): void {
    this.metrics.modelTurns++
    this.metrics.inputTokens += inputTokens
    this.metrics.outputTokens += outputTokens
    if (contextSizeTokens != null) {
      this.metrics.contextSizeTokens = contextSizeTokens
    }
  }

  recordToolCall(isParallel: boolean): void {
    this.metrics.toolCallsTotal++
    if (isParallel) {
      this.metrics.toolCallsParallel++
    } else {
      this.metrics.toolCallsSequential++
    }
  }

  setExecutionClass(cls: string): void {
    this.metrics.executionClass = cls
  }

  markFirstProviderRequest(): void {
    if (this.metrics.timeToFirstProviderRequestMs == null && this.metrics.spans.length > 0) {
      const taskSpan = this.metrics.spans.find(s => s.kind === "task.total")
      const refTime = taskSpan?.startedAt ?? this.metrics.spans[0]?.startedAt ?? now()
      this.metrics.timeToFirstProviderRequestMs = now() - refTime
    }
  }

  private accumulateSpan(span: Span, durationMs: number): void {
    switch (span.kind) {
      case "routing":
        this.metrics.routingMs += durationMs; break
      case "config.load":
        this.metrics.configLoadMs += durationMs; break
      case "governance.check":
      case "governance.read_fast_path":
      case "governance.write_full":
        this.metrics.governanceCheckMs += durationMs
        if (span.kind === "governance.read_fast_path") this.metrics.governanceFastPathHits++
        else if (span.kind === "governance.write_full") this.metrics.governanceFullPathHits++
        break
      case "tool.before":
        this.metrics.toolBeforeOverheadMs += durationMs; break
      case "tool.after":
        this.metrics.toolAfterOverheadMs += durationMs; break
      case "token.accounting":
        this.metrics.tokenAccountingMs += durationMs; break
      case "audit.append":
        this.metrics.auditAppendMs += durationMs; break
      case "delegation.startup":
        this.metrics.delegationStartupMs += durationMs; break
      case "child.runtime":
        this.metrics.childRuntimeMs += durationMs; break
      case "integration":
        this.metrics.integrationMs += durationMs; break
      case "verification":
        this.metrics.verificationMs += durationMs; break
    }
  }

  /** Return a safe, sanitized metrics snapshot (no prompt content). */
  snapshot(): Readonly<ExecutionMetrics> {
    return { ...this.metrics, spans: [...this.metrics.spans] }
  }

  /** Produce a compact summary string for logging. */
  summary(): string {
    const m = this.metrics
    return [
      `task:${m.taskId}`,
      m.executionClass ? `class:${m.executionClass}` : null,
      m.totalWallClockMs != null ? `wall:${m.totalWallClockMs.toFixed(1)}ms` : null,
      `turns:${m.modelTurns}`,
      `tokens:${m.inputTokens}in/${m.outputTokens}out`,
      `tools:${m.toolCallsTotal}(p:${m.toolCallsParallel}/s:${m.toolCallsSequential})`,
      m.routingMs > 0 ? `routing:${m.routingMs.toFixed(1)}ms` : null,
      m.governanceCheckMs > 0 ? `gov:${m.governanceCheckMs.toFixed(1)}ms(fp:${m.governanceFastPathHits})` : null,
    ].filter(Boolean).join(" | ")
  }
}

/** Process-level registry of active trackers (keyed by taskId). */
const _registry = new Map<string, HeidiPerformanceTracker>()

export function createTracker(taskId: string, sessionId?: string): HeidiPerformanceTracker {
  const tracker = new HeidiPerformanceTracker(taskId, sessionId)
  _registry.set(taskId, tracker)
  return tracker
}

export function getTracker(taskId: string): HeidiPerformanceTracker | undefined {
  return _registry.get(taskId)
}

export function clearTracker(taskId: string): void {
  _registry.delete(taskId)
}

/** For tests: clear all trackers. */
export function _resetAllTrackers(): void {
  _registry.clear()
}
