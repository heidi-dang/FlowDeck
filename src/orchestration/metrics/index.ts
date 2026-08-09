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

const METRIC_DESCRIPTIONS: Record<string, string> = {
  commands_dispatched: "Number of commands dispatched",
  commands_succeeded: "Number of commands succeeded",
  commands_failed: "Number of commands failed",
  events_published: "Number of events published",
  events_delivered: "Number of events delivered",
  events_failed: "Number of events failed",
  replays_started: "Number of replays started",
  replays_completed: "Number of replays completed",
  runs_completed: "Number of runs completed",
  runs_failed: "Number of runs failed",
  dead_letter_count: "Number of dead-letter messages",
  active_runs: "Number of active runs",
  subscriber_lag: "Subscriber lag",
  query_latency_ms: "Query latency in milliseconds",
  verification_latency_ms: "Verification latency in milliseconds",
  completion_latency_ms: "Completion latency in milliseconds",
};

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
  readonly routingDecisions: Counter;
  readonly routingShadowDivergence: Counter;
  readonly routingShadowFailures: Counter;
  readonly executionPlans: Counter;
  readonly workstreamsStarted: Counter;
  readonly workstreamsBlocked: Counter;
  readonly workstreamsSucceeded: Counter;
  readonly workstreamsFailed: Counter;
  readonly dependencyBlocks: Counter;
  readonly worktreeLeaseConflicts: Counter;
  readonly worktreeLeaseReclaims: Counter;
  readonly ownershipConflicts: Counter;
  readonly duplicateWorkSuppressed: Counter;
  readonly integrationAttempts: Counter;
  readonly integrationsCompleted: Counter;
  readonly integrationConflicts: Counter;
  readonly budgetReclaimed: Counter;
  readonly budgetRedistributed: Counter;
  readonly executionStalls: Counter;
  readonly executionTerminations: Counter;
  readonly performanceObservations: Counter;
  readonly performanceEligibleProfiles: Counter;
  readonly performanceInsufficientProfiles: Counter;
  readonly fdxDaemonRequests: Counter;
  readonly fdxFallbacks: Counter;
  readonly fdxCacheHits: Counter;
  readonly fdxCacheMisses: Counter;
  readonly fdxIndexUpdates: Counter;
  readonly recoveryAttempts: Counter;
  readonly recoverySucceeded: Counter;
  readonly routingAssessmentLatency: Histogram;

  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly labeledCounters = new Map<string, number>();

  constructor() {
    this.commandsDispatched = createCounter("commands_dispatched", this.counters);
    this.commandsSucceeded = createCounter("commands_succeeded", this.counters);
    this.commandsFailed = createCounter("commands_failed", this.counters);
    this.eventsPublished = createCounter("events_published", this.counters);
    this.eventsDelivered = createCounter("events_delivered", this.counters);
    this.eventsFailed = createCounter("events_failed", this.counters);
    this.replaysStarted = createCounter("replays_started", this.counters);
    this.replaysCompleted = createCounter("replays_completed", this.counters);
    this.runsCompleted = createCounter("runs_completed", this.counters);
    this.runsFailed = createCounter("runs_failed", this.counters);
    this.deadLetterCount = createCounter("dead_letter_count", this.counters);
    this.routingDecisions = createCounter("routing_decisions_total", this.counters);
    this.routingShadowDivergence = createCounter("routing_shadow_divergence_total", this.counters);
    this.routingShadowFailures = createCounter("routing_shadow_failures_total", this.counters);
    this.executionPlans = createCounter("execution_plans_total", this.counters);
    this.workstreamsStarted = createCounter("execution_workstreams_started_total", this.counters);
    this.workstreamsBlocked = createCounter("execution_workstreams_blocked_total", this.counters);
    this.workstreamsSucceeded = createCounter("execution_workstreams_succeeded_total", this.counters);
    this.workstreamsFailed = createCounter("execution_workstreams_failed_total", this.counters);
    this.dependencyBlocks = createCounter("execution_dependency_blocks_total", this.counters);
    this.worktreeLeaseConflicts = createCounter("worktree_lease_conflicts_total", this.counters);
    this.worktreeLeaseReclaims = createCounter("worktree_lease_reclaims_total", this.counters);
    this.ownershipConflicts = createCounter("execution_ownership_conflicts_total", this.counters);
    this.duplicateWorkSuppressed = createCounter("execution_duplicate_work_suppressed_total", this.counters);
    this.integrationAttempts = createCounter("execution_integration_attempts_total", this.counters);
    this.integrationsCompleted = createCounter("execution_integrations_completed_total", this.counters);
    this.integrationConflicts = createCounter("execution_integration_conflicts_total", this.counters);
    this.budgetReclaimed = createCounter("token_budget_reclaimed_total", this.counters);
    this.budgetRedistributed = createCounter("token_budget_redistributed_total", this.counters);
    this.executionStalls = createCounter("execution_stalls_total", this.counters);
    this.executionTerminations = createCounter("execution_terminations_total", this.counters);
    this.performanceObservations = createCounter("agent_performance_observations_total", this.counters);
    this.performanceEligibleProfiles = createCounter("agent_performance_eligible_profiles_total", this.counters);
    this.performanceInsufficientProfiles = createCounter("agent_performance_insufficient_profiles_total", this.counters);
    this.fdxDaemonRequests = createCounter("fdx_daemon_requests_total", this.counters);
    this.fdxFallbacks = createCounter("fdx_fallbacks_total", this.counters);
    this.fdxCacheHits = createCounter("fdx_cache_hits_total", this.counters);
    this.fdxCacheMisses = createCounter("fdx_cache_misses_total", this.counters);
    this.fdxIndexUpdates = createCounter("fdx_index_updates_total", this.counters);
    this.recoveryAttempts = createCounter("orchestration_recovery_attempts_total", this.counters);
    this.recoverySucceeded = createCounter("orchestration_recovery_succeeded_total", this.counters);

    this.queryLatency = createHistogram("query_latency_ms", this.histograms);
    this.verificationLatency = createHistogram("verification_latency_ms", this.histograms);
    this.completionLatency = createHistogram("completion_latency_ms", this.histograms);
    this.routingAssessmentLatency = createHistogram("routing_assessment_duration", this.histograms);

    this.activeRuns = createGauge("active_runs", this.gauges);
    this.subscriberLag = createGauge("subscriber_lag", this.gauges);
  }

  recordRoutingDecision(taskClass: string, strategy: string, delegated: boolean, divergent: boolean, durationMs: number, parallelism = "none"): void {
    this.routingDecisions.inc()
    this.routingAssessmentLatency.observe(durationMs)
    this.incBounded("routing_task_class_total", "class", taskClass)
    this.incBounded("routing_strategy_total", "strategy", strategy)
    this.incBounded("routing_parallelism_total", "parallelism", parallelism)
    if (delegated) this.incBounded("routing_delegation_recommended_total", "mode", "delegated")
    if (divergent) this.routingShadowDivergence.inc()
  }

  private incBounded(name: string, key: string, value: string): void {
    const allowed: Record<string, readonly string[]> = {
      class: ["small_bug", "large_bug", "feature", "refactor", "architecture", "investigation", "security", "performance", "testing", "documentation", "migration", "release", "ci_infrastructure", "dependency", "code_review", "audit", "multi_component", "unknown"],
      strategy: ["direct", "investigate_then_direct", "plan_then_execute", "debug_root_cause", "parallel_implementation", "security_review", "performance_investigation", "audit_only", "change_then_independent_review"],
      mode: ["delegated"],
      parallelism: ["none", "limited", "high"],
    }
    if (!allowed[key]?.includes(value)) throw new Error("ROUTING_METRIC_LABEL_OUT_OF_RANGE")
    const id = `${name}{${key}="${value}"}`
    this.labeledCounters.set(id, (this.labeledCounters.get(id) ?? 0) + 1)
  }

  /** Fails closed if a caller attempts to introduce an unbounded label. */
  assertBoundedCardinality(): void {
    const forbidden = new Set(["runId", "sessionId", "workstreamId", "decisionId", "sourceSha", "sha", "path", "filePath", "workspace", "worktreePath", "prompt", "task"])
    for (const metric of this.snapshot()) for (const label of Object.keys(metric.labels ?? {})) if (forbidden.has(label)) throw new Error(`METRIC_FORBIDDEN_LABEL:${label}`)
  }

  recordPerformanceProfile(eligible: boolean): void { (eligible ? this.performanceEligibleProfiles : this.performanceInsufficientProfiles).inc() }
  recordFdx(source: "daemon" | "cache" | "compute" | "fallback", indexed = false): void {
    if (source === "daemon") this.fdxDaemonRequests.inc()
    if (source === "fallback") this.fdxFallbacks.inc()
    if (source === "cache") this.fdxCacheHits.inc()
    if (source === "compute") this.fdxCacheMisses.inc()
    if (indexed) this.fdxIndexUpdates.inc()
  }

  snapshot(): MetricValue[] {
    const timestamp = new Date().toISOString();
    const result: MetricValue[] = [];

    for (const [name, val] of this.counters.entries()) {
      result.push({ name, value: val, timestamp });
    }
    for (const [name, val] of this.labeledCounters.entries()) result.push({ name, value: val, labels: parseLabels(name), timestamp });

    for (const [name, val] of this.gauges.entries()) {
      result.push({ name, value: val, timestamp });
    }

    for (const [name, values] of this.histograms.entries()) {
      const stats = getHistogramStats(values);
      result.push({ name: `${name}_count`, value: stats.count, timestamp });
      result.push({ name: `${name}_sum`, value: stats.sum, timestamp });
      result.push({ name: `${name}_min`, value: stats.min, timestamp });
      result.push({ name: `${name}_max`, value: stats.max, timestamp });
      result.push({ name: `${name}_avg`, value: stats.avg, timestamp });
    }

    return result;
  }

  toPrometheusText(): string {
    let output = "";

    const formatMetric = (name: string, type: string, value: number, suffix = "") => {
      const metricName = suffix ? `${name}_${suffix}` : name;
      const helpDesc = METRIC_DESCRIPTIONS[name]
        ? `${METRIC_DESCRIPTIONS[name]}${suffix ? ` (${suffix})` : ""}`
        : "";
      let chunk = "";
      if (helpDesc) {
        chunk += `# HELP ${metricName} ${helpDesc}\n`;
      }
      const prometheusType = type === "histogram"
        ? (suffix === "count" ? "counter" : "gauge")
        : type;

      chunk += `# TYPE ${metricName} ${prometheusType}\n`;
      chunk += `${metricName} ${value}\n`;
      return chunk;
    };

    for (const [name, val] of this.counters.entries()) {
      output += formatMetric(name, "counter", val) + "\n";
    }
    for (const [name, val] of this.labeledCounters.entries()) {
      const metric = name.slice(0, name.indexOf("{"));
      output += `${metric} ${name.slice(name.indexOf("{"))} ${val}\n`;
    }

    for (const [name, val] of this.gauges.entries()) {
      output += formatMetric(name, "gauge", val) + "\n";
    }

    for (const [name, values] of this.histograms.entries()) {
      const stats = getHistogramStats(values);
      output += formatMetric(name, "histogram", stats.count, "count") + "\n";
      output += formatMetric(name, "histogram", stats.sum, "sum") + "\n";
      output += formatMetric(name, "histogram", stats.min, "min") + "\n";
      output += formatMetric(name, "histogram", stats.max, "max") + "\n";
      output += formatMetric(name, "histogram", stats.avg, "avg") + "\n";
    }

    return output;
  }

  toOpenTelemetry(): Record<string, unknown> {
    const timestamp = Date.now();
    const metricsList: Record<string, unknown>[] = [];

    for (const [name, val] of this.counters.entries()) {
      metricsList.push({
        name,
        description: METRIC_DESCRIPTIONS[name] ?? "",
        unit: "1",
        sum: {
          dataPoints: [
            {
              asInt: val,
              timeUnixNano: String(timestamp * 1000000)
            }
          ],
          isMonotonic: true,
          aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE"
        }
      });
    }
    for (const [name, val] of this.labeledCounters.entries()) {
      metricsList.push({ name: name.slice(0, name.indexOf("{")), description: METRIC_DESCRIPTIONS[name.slice(0, name.indexOf("{"))] ?? "", unit: "1", sum: { dataPoints: [{ asInt: val, attributes: parseLabels(name), timeUnixNano: String(timestamp * 1000000) }], isMonotonic: true, aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" } });
    }

    for (const [name, val] of this.gauges.entries()) {
      metricsList.push({
        name,
        description: METRIC_DESCRIPTIONS[name] ?? "",
        unit: "1",
        gauge: {
          dataPoints: [
            {
              asInt: val,
              timeUnixNano: String(timestamp * 1000000)
            }
          ]
        }
      });
    }

    for (const [name, values] of this.histograms.entries()) {
      const stats = getHistogramStats(values);
      metricsList.push({
        name,
        description: METRIC_DESCRIPTIONS[name] ?? "",
        unit: "ms",
        histogram: {
          dataPoints: [
            {
              count: String(stats.count),
              sum: stats.sum,
              min: stats.min,
              max: stats.max,
              timeUnixNano: String(timestamp * 1000000)
            }
          ],
          aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE"
        }
      });
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: {
              "service.name": "flowdeck-orchestration"
            }
          },
          scopeMetrics: [
            {
              scope: {
                name: "flowdeck-orchestration-metrics"
              },
              metrics: metricsList
            }
          ]
        }
      ]
    };
  }
}

function parseLabels(metric: string): Record<string, string> {
  const match = metric.match(/\{([^}]*)\}/); const out: Record<string, string> = {};
  for (const pair of match?.[1]?.split(",") ?? []) { const [k, v] = pair.split("="); if (k && v) out[k] = v.replace(/^"|"$/g, ""); }
  return out;
}

function getHistogramStats(values: number[]) {
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const min = count ? Math.min(...values) : 0;
  const max = count ? Math.max(...values) : 0;
  const avg = count ? sum / count : 0;
  return { count, sum, min, max, avg };
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
