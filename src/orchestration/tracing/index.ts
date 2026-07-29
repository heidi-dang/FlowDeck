export interface Span {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
  status?: { code: number; message?: string };
}

// ── OpenTelemetry-compatible tracer ────────────────────────────────────────

export class Tracer {
  private readonly spans = new Map<string, Span>();
  private spanCounter = 0;

  constructor(private readonly serviceName: string = "flowdeck-orchestration") {}

  startSpan(
    name: string,
    options?: { parentSpanId?: string; attributes?: Record<string, string | number | boolean> },
  ): Span {
    const spanId = `span-${++this.spanCounter}-${Date.now()}`;
    const traceId = this.getTraceId(options?.parentSpanId);
    const span: Span = {
      name,
      spanId,
      traceId,
      parentSpanId: options?.parentSpanId,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      events: [],
    };
    this.spans.set(spanId, span);
    return span;
  }

  endSpan(span: Span, status?: { code: number; message?: string }): void {
    span.endTime = Date.now();
    if (status) span.status = status;
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({ name, timestamp: Date.now(), attributes });
  }

  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: { parentSpanId?: string; attributes?: Record<string, string | number | boolean> },
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return fn(span).finally(() => this.endSpan(span));
  }

  injectCorrelationIds(span: Span): { traceparent?: string; tracestate?: string } {
    const traceparent = `00-${span.traceId}-${span.spanId}-01`;
    return { traceparent };
  }

  private getTraceId(parentSpanId?: string): string {
    if (parentSpanId) {
      const parent = this.spans.get(parentSpanId);
      if (parent) return parent.traceId;
    }
    return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
