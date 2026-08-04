/**
 * Metrics Collector
 * Centralized metrics collection for FlowDeck benchmarks
 */

export interface CollectableMetrics {
  timestamp: number;
  duration?: number;
  memory?: MemoryMetrics;
  tokens?: TokenMetrics;
  contextItems?: number;
  events?: EventMetrics;
  database?: DatabaseMetrics;
  custom?: Record<string, number>;
}

export interface MemoryMetrics {
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
  arrayBuffers?: number;
}

export interface TokenMetrics {
  input: number;
  output: number;
  total: number;
  contextLimit?: number;
  utilizationPercent?: number;
}

export interface EventMetrics {
  totalEmitted: number;
  byType: Record<string, number>;
  errors: number;
  warnings: number;
}

export interface DatabaseMetrics {
  queriesExecuted: number;
  queriesFailed: number;
  avgQueryTimeMs: number;
  transactionsCommitted: number;
  transactionsRolledBack: number;
  connectionPoolSize: number;
  activeConnections: number;
}

export interface MetricsSnapshot {
  id: string;
  benchmarkId: string;
  scenarioId: string;
  iteration: number;
  phase: 'warmup' | 'measured';
  timestamp: number;
  metrics: CollectableMetrics;
}

export interface AggregatedMetrics {
  scenarioId: string;
  iterationCount: number;
  duration: AggregatedStatistic;
  memory: AggregatedMemoryMetrics;
  tokens: AggregatedTokenMetrics;
  contextItems: AggregatedStatistic;
  events: AggregatedEventMetrics;
  database: AggregatedDatabaseMetrics;
}

export interface AggregatedStatistic {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface AggregatedMemoryMetrics {
  heapUsed: AggregatedStatistic;
  heapTotal: AggregatedStatistic;
  external: AggregatedStatistic;
  rss: AggregatedStatistic;
}

export interface AggregatedTokenMetrics {
  input: AggregatedStatistic;
  output: AggregatedStatistic;
  total: AggregatedStatistic;
}

export interface AggregatedEventMetrics {
  totalEmitted: AggregatedStatistic;
  errors: AggregatedStatistic;
  warnings: AggregatedStatistic;
  byTypeMax: Record<string, number>;
}

export interface AggregatedDatabaseMetrics {
  queriesExecuted: AggregatedStatistic;
  avgQueryTimeMs: AggregatedStatistic;
  transactionsCommitted: AggregatedStatistic;
  transactionsRolledBack: AggregatedStatistic;
}

export interface RegressionThreshold {
  metric: string;
  warningPercent: number;
  criticalPercent: number;
}

export class MetricsCollector {
  private snapshots: MetricsSnapshot[] = [];
  private currentBenchmarkId: string | null = null;
  private currentScenarioId: string | null = null;
  private iterationCount = 0;

  private static defaultThresholds: RegressionThreshold[] = [
    { metric: 'duration', warningPercent: 10, criticalPercent: 50 },
    { metric: 'memory.heapUsed', warningPercent: 20, criticalPercent: 50 },
    { metric: 'tokens.total', warningPercent: 15, criticalPercent: 30 },
    { metric: 'contextItems', warningPercent: 25, criticalPercent: 50 },
    { metric: 'events.totalEmitted', warningPercent: 30, criticalPercent: 100 },
    { metric: 'database.avgQueryTimeMs', warningPercent: 25, criticalPercent: 100 },
  ];

  private thresholds: RegressionThreshold[];

  constructor(thresholds?: RegressionThreshold[]) {
    this.thresholds = thresholds ?? MetricsCollector.defaultThresholds;
  }

  startBenchmark(benchmarkId: string): void {
    this.currentBenchmarkId = benchmarkId;
    this.snapshots = [];
  }

  startScenario(scenarioId: string): void {
    this.currentScenarioId = scenarioId;
    this.iterationCount = 0;
  }

  recordIteration(
    phase: 'warmup' | 'measured',
    metrics: CollectableMetrics
  ): MetricsSnapshot {
    if (!this.currentBenchmarkId || !this.currentScenarioId) {
      throw new Error('Must call startBenchmark and startScenario first');
    }

    this.iterationCount++;
    const snapshot: MetricsSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      benchmarkId: this.currentBenchmarkId,
      scenarioId: this.currentScenarioId,
      iteration: this.iterationCount,
      phase,
      timestamp: Date.now(),
      metrics,
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  captureMemoryMetrics(): MemoryMetrics {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
      externalMB: Math.round((usage.external / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
    };
  }

  aggregateMetrics(scenarioId: string, phase?: 'warmup' | 'measured'): AggregatedMetrics {
    const relevant = this.snapshots.filter(
      (s) =>
        s.scenarioId === scenarioId &&
        (phase === undefined || s.phase === phase)
    );

    if (relevant.length === 0) {
      throw new Error(`No snapshots found for scenario: ${scenarioId}`);
    }

    const durations = relevant.map((s) => s.metrics.duration ?? 0).filter((d) => d > 0);
    const heapUsed = relevant.map((s) => s.metrics.memory?.heapUsedMB ?? 0);
    const heapTotal = relevant.map((s) => s.metrics.memory?.heapTotalMB ?? 0);
    const external = relevant.map((s) => s.metrics.memory?.externalMB ?? 0);
    const rss = relevant.map((s) => s.metrics.memory?.rssMB ?? 0);
    const inputTokens = relevant.map((s) => s.metrics.tokens?.input ?? 0);
    const outputTokens = relevant.map((s) => s.metrics.tokens?.output ?? 0);
    const totalTokens = relevant.map((s) => s.metrics.tokens?.total ?? 0);
    const contextItems = relevant.map((s) => s.metrics.contextItems ?? 0);

    return {
      scenarioId,
      iterationCount: relevant.length,
      duration: this.aggregateStatistic(durations),
      memory: {
        heapUsed: this.aggregateStatistic(heapUsed),
        heapTotal: this.aggregateStatistic(heapTotal),
        external: this.aggregateStatistic(external),
        rss: this.aggregateStatistic(rss),
      },
      tokens: {
        input: this.aggregateStatistic(inputTokens),
        output: this.aggregateStatistic(outputTokens),
        total: this.aggregateStatistic(totalTokens),
      },
      contextItems: this.aggregateStatistic(contextItems),
      events: this.aggregateEventMetrics(relevant),
      database: this.aggregateDatabaseMetrics(relevant),
    };
  }

  protected aggregateStatistic(values: number[]): AggregatedStatistic {
    if (values.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Math.round(mean * 100) / 100,
      median: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      stdDev: Math.round(stdDev * 100) / 100,
    };
  }

  protected percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  protected aggregateEventMetrics(snapshots: MetricsSnapshot[]): AggregatedEventMetrics {
    const totalEmitted = snapshots.map((s) => s.metrics.events?.totalEmitted ?? 0);
    const errors = snapshots.map((s) => s.metrics.events?.errors ?? 0);
    const warnings = snapshots.map((s) => s.metrics.events?.warnings ?? 0);

    const byTypeMax: Record<string, number> = {};
    for (const snap of snapshots) {
      if (snap.metrics.events?.byType) {
        for (const [type, count] of Object.entries(snap.metrics.events.byType)) {
          byTypeMax[type] = Math.max(byTypeMax[type] ?? 0, count);
        }
      }
    }

    return {
      totalEmitted: this.aggregateStatistic(totalEmitted),
      errors: this.aggregateStatistic(errors),
      warnings: this.aggregateStatistic(warnings),
      byTypeMax,
    };
  }

  protected aggregateDatabaseMetrics(snapshots: MetricsSnapshot[]): AggregatedDatabaseMetrics {
    const queriesExecuted = snapshots.map((s) => s.metrics.database?.queriesExecuted ?? 0);
    const avgQueryTimeMs = snapshots.map((s) => s.metrics.database?.avgQueryTimeMs ?? 0);
    const committed = snapshots.map(
      (s) => s.metrics.database?.transactionsCommitted ?? 0
    );
    const rolledBack = snapshots.map(
      (s) => s.metrics.database?.transactionsRolledBack ?? 0
    );

    return {
      queriesExecuted: this.aggregateStatistic(queriesExecuted),
      avgQueryTimeMs: this.aggregateStatistic(avgQueryTimeMs),
      transactionsCommitted: this.aggregateStatistic(committed),
      transactionsRolledBack: this.aggregateStatistic(rolledBack),
    };
  }

  detectRegressions(
    baseline: AggregatedMetrics,
    candidate: AggregatedMetrics
  ): Map<string, { severity: 'none' | 'warning' | 'critical'; delta: number }> {
    const results = new Map<
      string,
      { severity: 'none' | 'warning' | 'critical'; delta: number }
    >();

    // Duration
    this.checkRegression(
      results,
      'duration',
      baseline.duration.median,
      candidate.duration.median
    );

    // Memory
    this.checkRegression(
      results,
      'memory.heapUsed',
      baseline.memory.heapUsed.median,
      candidate.memory.heapUsed.median
    );

    // Tokens
    this.checkRegression(
      results,
      'tokens.total',
      baseline.tokens.total.median,
      candidate.tokens.total.median
    );

    // Context Items
    this.checkRegression(
      results,
      'contextItems',
      baseline.contextItems.median,
      candidate.contextItems.median
    );

    return results;
  }

  protected checkRegression(
    results: Map<string, { severity: 'none' | 'warning' | 'critical'; delta: number }>,
    metric: string,
    baseline: number,
    candidate: number
  ): void {
    const threshold = this.thresholds.find((t) => t.metric === metric);
    if (!threshold) return;

    if (baseline === 0) {
      results.set(metric, { severity: 'none', delta: 0 });
      return;
    }

    const deltaPercent = ((candidate - baseline) / baseline) * 100;

    let severity: 'none' | 'warning' | 'critical' = 'none';
    if (deltaPercent >= threshold.criticalPercent) {
      severity = 'critical';
    } else if (deltaPercent >= threshold.warningPercent) {
      severity = 'warning';
    }

    results.set(metric, {
      severity,
      delta: Math.round(deltaPercent * 100) / 100,
    });
  }

  generateReport(baseline: AggregatedMetrics, candidate: AggregatedMetrics): string {
    const lines: string[] = [];
    lines.push('=== Benchmark Comparison Report ===');
    lines.push(`Scenario: ${baseline.scenarioId}`);
    lines.push(`Iterations: ${baseline.iterationCount}`);
    lines.push('');
    lines.push('Metric           | Baseline | Candidate | Delta % | Status');
    lines.push('-----------------|----------|-----------|---------|--------');

    const addRow = (
      metric: string,
      baseline: number,
      candidate: number,
      unit = ''
    ) => {
      const delta = baseline > 0 ? ((candidate - baseline) / baseline) * 100 : 0;
      const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
      const baselineStr = `${baseline.toFixed(2)}${unit}`;
      const candidateStr = `${candidate.toFixed(2)}${unit}`;
      lines.push(`${metric.padEnd(16)} | ${baselineStr.padStart(8)} | ${candidateStr.padStart(9)} | ${deltaStr.padStart(7)} |`);
    };

    addRow('Duration (ms)', baseline.duration.median, candidate.duration.median);
    addRow('Memory (MB)', baseline.memory.heapUsed.median, candidate.memory.heapUsed.median);
    addRow('Tokens', baseline.tokens.total.median, candidate.tokens.total.median);
    addRow('Context Items', baseline.contextItems.median, candidate.contextItems.median);

    lines.push('');
    lines.push('Regressions:');

    const regressions = this.detectRegressions(baseline, candidate);
    let hasRegressions = false;
    for (const [metric, result] of regressions) {
      if (result.severity !== 'none') {
        hasRegressions = true;
        lines.push(`  - ${metric}: ${result.severity.toUpperCase()} (${result.delta}%)`);
      }
    }

    if (!hasRegressions) {
      lines.push('  None detected');
    }

    return lines.join('\n');
  }

  exportSnapshots(): string {
    return JSON.stringify(this.snapshots, null, 2);
  }

  getSnapshots(scenarioId?: string): MetricsSnapshot[] {
    if (scenarioId) {
      return this.snapshots.filter((s) => s.scenarioId === scenarioId);
    }
    return [...this.snapshots];
  }

  clear(): void {
    this.snapshots = [];
    this.currentBenchmarkId = null;
    this.currentScenarioId = null;
    this.iterationCount = 0;
  }
}

export const globalMetricsCollector = new MetricsCollector();
