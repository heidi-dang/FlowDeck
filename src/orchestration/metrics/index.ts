export interface MetricValue {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: string;
}

export interface Counter {
  inc(value?: number): void;
  get(): number;
  reset(): void;
}

export interface Gauge {
  set(value: number): void;
  inc(value?: number): void;
  dec(value?: number): void;
  get(): number;
}

export interface Histogram {
  observe(value: number): void;
  get(): { count: number; sum: number; min: number; max: number; avg: number };
}

// ── OrchestrationMetrics ───────────────────────────────────────────────────

export class OrchestrationMetrics {
  // Command throughput
  readonly commandsDispatched: Counter;
  readonly commandsSucceeded: Counter;
  readonly commandsFailed: Counter;

  // Query latency
  readonly queryLatency: Histogram;

  // Event throughput
  readonly eventsPublished: Counter;
  readonly eventsDelivered: Counter;
  readonly eventsFailed: Counter;

  // Replay throughput
  readonly replaysStarted: Counter;
  readonly replaysCompleted: Counter;

  // Active runs
  readonly activeRuns: Gauge;
  readonly runsCompleted: Counter;
  readonly runsFailed: Counter;

  // Verification latency
  readonly verificationLatency: Histogram;

  // Completion latency
  readonly completionLatency: Histogram;

  // Subscriber lag
  readonly subscriberLag: Gauge;

  // Dead-letter count
  readonly deadLetterCount: Counter;

  constructor() {
    const now = () => new Date().toISOString();
    const counters = new Map<string, number>();
    const gauges = new Map<string, number>();
    const histograms = new Map<string, number[]>();

    this.commandsDispatched = createCounter("commands_dispatched", counters);
    this.commandsSucceeded = createCounter("commands_succeeded", counters);
    this.commandsFailed = createCounter("commands_failed", counters);
    this.eventsPublished = createCounter("events_published", counters);
    this.eventsDelivered = createCounter("events_delivered", counters);
    this.eventsFailed = createCounter("events_failed", counters);
    this.replaysStarted = createCounter("replays_started", counters);
    this.replaysCompleted = createCounter("replays_completed", counters);
    this.runsCompleted = createCounter("runs_completed", counters);
    this.runsFailed = createCounter("runs_failed", counters);
    this.deadLetterCount = createCounter("dead_letter_count", counters);

    this.queryLatency = createHistogram("query_latency_ms", histograms);
    this.verificationLatency = createHistogram("verification_latency_ms", histograms);
    this.completionLatency = createHistogram("completion_latency_ms", histograms);

    this.activeRuns = createGauge("active_runs", gauges);
    this.subscriberLag = createGauge("subscriber_lag", gauges);
  }

  snapshot(): MetricValue[] {
    return []; // In production, expose via /metrics endpoint
  }

  toPrometheusText(): string {
    return "# orchestration metrics endpoint placeholder\n";
  }

  toOpenTelemetry(): Record<string, unknown> {
    return { metrics: {} };
  }
}

function createCounter(name: string, store: Map<string, number>): Counter {
  store.set(name, 0);
  return {
    inc(value = 1) { store.set(name, (store.get(name) ?? 0) + value); },
    get() { return store.get(name) ?? 0; },
    reset() { store.set(name, 0); },
  };
}

function createGauge(name: string, store: Map<string, number>): Gauge {
  store.set(name, 0);
  return {
    set(value: number) { store.set(name, value); },
    inc(value = 1) { store.set(name, (store.get(name) ?? 0) + value); },
    dec(value = 1) { store.set(name, (store.get(name) ?? 0) - value); },
    get() { return store.get(name) ?? 0; },
  };
}

function createHistogram(name: string, store: Map<string, number[]>): Histogram {
  store.set(name, []);
  return {
    observe(value: number) { store.get(name)?.push(value); },
    get() {
      const vals = store.get(name) ?? [];
      return {
        count: vals.length,
        sum: vals.reduce((a, b) => a + b, 0),
        min: vals.length ? Math.min(...vals) : 0,
        max: vals.length ? Math.max(...vals) : 0,
        avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
      };
    },
  };
}
