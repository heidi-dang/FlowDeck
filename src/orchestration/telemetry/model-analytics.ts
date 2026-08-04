// ── Input Types ────────────────────────────────────────────────────────────────

export interface CompletionMetrics {
  modelId: string;
  taskClass: string;
  latencyMs: number;
  firstTokenLatencyMs: number;
  completionLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  success: boolean;
  recovered: boolean;
  fallback: boolean;
  contextUtilization: number;
}

// ── Output Types ───────────────────────────────────────────────────────────────

export interface ModelMetrics {
  modelId: string;
  taskClass: string;
  latency: {
    p50: number;
    p95: number;
    p99: number;
  };
  firstTokenLatency: number;
  completionLatency: number;
  tokens: {
    input: number;
    output: number;
  };
  cost: number;
  successRate: number;
  recoveryRate: number;
  fallbackRate: number;
  contextUtilization: number;
}

export interface ModelAggregateMetrics {
  overallSuccessRate: number;
  overallRecoveryRate: number;
  overallFallbackRate: number;
  averageLatencyP50: number;
  averageLatencyP95: number;
  averageLatencyP99: number;
  averageFirstTokenLatency: number;
  averageCompletionLatency: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  averageContextUtilization: number;
  totalCompletions: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// ── Model Analytics ────────────────────────────────────────────────────────────

interface CompletionRecord {
  metrics: CompletionMetrics;
  timestamp: number;
}

export class ModelAnalytics {
  private readonly completions: Map<string, CompletionRecord[]> = new Map();

  recordCompletion(modelId: string, metrics: CompletionMetrics): void {
    const records = this.completions.get(modelId) ?? [];
    records.push({ metrics, timestamp: Date.now() });
    this.completions.set(modelId, records);
  }

  getModelMetrics(modelId: string): ModelMetrics {
    const records = this.completions.get(modelId) ?? [];
    if (records.length === 0) {
      return {
        modelId,
        taskClass: "",
        latency: { p50: 0, p95: 0, p99: 0 },
        firstTokenLatency: 0,
        completionLatency: 0,
        tokens: { input: 0, output: 0 },
        cost: 0,
        successRate: 0,
        recoveryRate: 0,
        fallbackRate: 0,
        contextUtilization: 0,
      };
    }

    const taskClasses = new Set<string>();
    const latencies: number[] = [];
    let totalFirstTokenLatency = 0;
    let totalCompletionLatency = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalSuccess = 0;
    let totalRecovered = 0;
    let totalFallback = 0;
    let totalContextUtilization = 0;

    for (const record of records) {
      const m = record.metrics;
      taskClasses.add(m.taskClass);
      latencies.push(m.latencyMs);
      totalFirstTokenLatency += m.firstTokenLatencyMs;
      totalCompletionLatency += m.completionLatencyMs;
      totalInputTokens += m.inputTokens;
      totalOutputTokens += m.outputTokens;
      totalCost += m.cost;
      if (m.success) totalSuccess++;
      if (m.recovered) totalRecovered++;
      if (m.fallback) totalFallback++;
      totalContextUtilization += m.contextUtilization;
    }

    const count = records.length;

    return {
      modelId,
      taskClass: Array.from(taskClasses).join(","),
      latency: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
      },
      firstTokenLatency: totalFirstTokenLatency / count,
      completionLatency: totalCompletionLatency / count,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
      },
      cost: totalCost,
      successRate: totalSuccess / count,
      recoveryRate: totalRecovered / count,
      fallbackRate: totalFallback / count,
      contextUtilization: totalContextUtilization / count,
    };
  }

  getAggregateMetrics(): ModelAggregateMetrics {
    let totalCompletions = 0;
    let totalSuccess = 0;
    let totalRecovered = 0;
    let totalFallback = 0;
    const allLatencies: number[] = [];
    let totalFirstTokenLatency = 0;
    let totalCompletionLatency = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalContextUtilization = 0;

    for (const records of this.completions.values()) {
      for (const record of records) {
        const m = record.metrics;
        totalCompletions++;
        if (m.success) totalSuccess++;
        if (m.recovered) totalRecovered++;
        if (m.fallback) totalFallback++;
        allLatencies.push(m.latencyMs);
        totalFirstTokenLatency += m.firstTokenLatencyMs;
        totalCompletionLatency += m.completionLatencyMs;
        totalInputTokens += m.inputTokens;
        totalOutputTokens += m.outputTokens;
        totalCost += m.cost;
        totalContextUtilization += m.contextUtilization;
      }
    }

    if (totalCompletions === 0) {
      return {
        overallSuccessRate: 0,
        overallRecoveryRate: 0,
        overallFallbackRate: 0,
        averageLatencyP50: 0,
        averageLatencyP95: 0,
        averageLatencyP99: 0,
        averageFirstTokenLatency: 0,
        averageCompletionLatency: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        averageContextUtilization: 0,
        totalCompletions: 0,
      };
    }

    return {
      overallSuccessRate: totalSuccess / totalCompletions,
      overallRecoveryRate: totalRecovered / totalCompletions,
      overallFallbackRate: totalFallback / totalCompletions,
      averageLatencyP50: percentile(allLatencies, 50),
      averageLatencyP95: percentile(allLatencies, 95),
      averageLatencyP99: percentile(allLatencies, 99),
      averageFirstTokenLatency: totalFirstTokenLatency / totalCompletions,
      averageCompletionLatency: totalCompletionLatency / totalCompletions,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      averageContextUtilization: totalContextUtilization / totalCompletions,
      totalCompletions,
    };
  }
}
