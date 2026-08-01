/**
 * Benchmark Runner Infrastructure
 * Provides deterministic, isolated benchmark execution for FlowDeck
 */

export interface BenchmarkMetrics {
  iterations: number;
  warmupIterations: number;
  timestamps: string[];
  durations: number[]; // ms
  memorySnapshots: MemorySnapshot[];
  contextSizes: number[];
  tokenCounts: TokenCounts[];
  successCount: number;
  failureCount: number;
  regressionCount: number;
}

export interface MemorySnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  timestamp: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  total: number;
}

export interface BenchmarkResult {
  name: string;
  scenario: string;
  baselineSha: string;
  candidateSha?: string;
  metrics: BenchmarkMetrics;
  comparison?: BenchmarkComparison;
  timestamp: string;
  environment: BenchmarkEnvironment;
}

export interface BenchmarkComparison {
  medianDeltaMs: number;
  p95DeltaMs: number;
  throughputDelta: number;
  regressions: Regression[];
  equivalentOutcomeRate: number;
}

export interface Regression {
  metric: string;
  baseline: number;
  candidate: number;
  deltaPercent: number;
  severity: 'none' | 'warning' | 'critical';
}

export interface BenchmarkEnvironment {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuCores: number;
  memoryTotalMB: number;
  flowdeckVersion: string;
}

export interface BenchmarkScenario {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  baselineIterations: number;
  milestoneIterations: number;
  timeout: number; // ms
  isolationLevel: 'process' | 'filesystem' | 'memory';
  setup?: () => Promise<void>;
  execute: () => Promise<BenchmarkExecution>;
  teardown?: () => Promise<void>;
  verifyDeterministic?: (results: BenchmarkResult[]) => boolean;
  warmupIterations?: number;
}

export type ScenarioCategory =
  | 'direct-edit'
  | 'local-bug'
  | 'cross-module'
  | 'ci-repair'
  | 'read-only-audit'
  | 'delegated-task'
  | 'verification-failure'
  | 'cancellation'
  | 'recovery'
  | 'stale-sha-rejection'
  | 'parallel-conflict'
  | 'fdx-parity';

export interface BenchmarkExecution {
  status: 'success' | 'failure' | 'regression';
  duration: number;
  memorySnapshot: MemorySnapshot;
  tokenCounts: TokenCounts;
  output: unknown;
  error?: string;
}

export interface ScenarioFixture {
  repositoryState: {
    files: Record<string, string>;
    gitSha: string;
    branch: string;
  };
  taskDescription: string;
  expectedOutcome: 'success' | 'failure' | 'cancelled';
  verificationCriteria?: string[];
}

export abstract class BaseBenchmarkRunner {
  protected scenarios: Map<string, BenchmarkScenario> = new Map();
  protected results: Map<string, BenchmarkResult> = new Map();
  protected baselineSha: string;
  protected environment: BenchmarkEnvironment;

  constructor(baselineSha: string) {
    this.baselineSha = baselineSha;
    this.environment = this.captureEnvironment();
  }

  protected captureEnvironment(): BenchmarkEnvironment {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCores: os.cpus().length,
      memoryTotalMB: Math.round(os.totalmem() / 1024 / 1024),
      flowdeckVersion: '1.0.3',
    };
  }

  registerScenario(scenario: BenchmarkScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  async runScenario(
    scenarioId: string,
    iterations?: number
  ): Promise<BenchmarkResult> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      throw new Error(`Scenario not found: ${scenarioId}`);
    }

    const actualIterations = iterations ?? scenario.baselineIterations;
    const warmupIterations = scenario.warmupIterations ?? Math.min(2, actualIterations);

    const metrics: BenchmarkMetrics = {
      iterations: actualIterations,
      warmupIterations,
      timestamps: [],
      durations: [],
      memorySnapshots: [],
      contextSizes: [],
      tokenCounts: [],
      successCount: 0,
      failureCount: 0,
      regressionCount: 0,
    };

    // Warmup phase
    for (let i = 0; i < warmupIterations; i++) {
      await this.executeScenario(scenario, false);
    }

    // Measured phase
    for (let i = 0; i < actualIterations; i++) {
      const execution = await this.executeScenario(scenario, true);
      metrics.timestamps.push(new Date().toISOString());
      metrics.durations.push(execution.duration);
      metrics.memorySnapshots.push(execution.memorySnapshot);
      metrics.tokenCounts.push(execution.tokenCounts);

      if (execution.status === 'success') {
        metrics.successCount++;
      } else if (execution.status === 'failure') {
        metrics.failureCount++;
      } else if (execution.status === 'regression') {
        metrics.regressionCount++;
      }
    }

    const result: BenchmarkResult = {
      name: scenario.name,
      scenario: scenarioId,
      baselineSha: this.baselineSha,
      metrics,
      timestamp: new Date().toISOString(),
      environment: this.environment,
    };

    this.results.set(scenarioId, result);
    return result;
  }

  protected async executeScenario(
    scenario: BenchmarkScenario,
    recordMetrics: boolean
  ): Promise<BenchmarkExecution> {
    const startMemory = this.captureMemory();
    const startTime = performance.now();

    try {
      if (scenario.setup) {
        await scenario.setup();
      }

      const execution = await scenario.execute();

      if (scenario.teardown) {
        await scenario.teardown();
      }

      const endTime = performance.now();
      const endMemory = this.captureMemory();

      return {
        status: execution.status,
        duration: endTime - startTime,
        memorySnapshot: endMemory,
        tokenCounts: execution.tokenCounts,
        output: execution.output,
        error: execution.error,
      };
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: this.captureMemory(),
        tokenCounts: { input: 0, output: 0, total: 0 },
        output: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected captureMemory(): MemorySnapshot {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
      timestamp: Date.now(),
    };
  }

  async runAllScenarios(iterations?: number): Promise<Map<string, BenchmarkResult>> {
    const runPromises = Array.from(this.scenarios.keys()).map((id) =>
      this.runScenario(id, iterations).catch((err) => {
        console.error(`Scenario ${id} failed:`, err);
        return null;
      })
    );

    await Promise.all(runPromises);
    return this.results;
  }

  compareWithBaseline(
    scenarioId: string,
    candidateResult: BenchmarkResult
  ): BenchmarkComparison {
    const baselineResult = this.results.get(scenarioId);
    if (!baselineResult) {
      throw new Error(`No baseline result for scenario: ${scenarioId}`);
    }

    const baselineMetrics = baselineResult.metrics;
    const candidateMetrics = candidateResult.metrics;

    const baselineMedian = this.calculateMedian(baselineMetrics.durations);
    const candidateMedian = this.calculateMedian(candidateMetrics.durations);

    const baselineP95 = this.calculatePercentile(baselineMetrics.durations, 95);
    const candidateP95 = this.calculatePercentile(candidateMetrics.durations, 95);

    const baselineThroughput = this.calculateThroughput(baselineMetrics);
    const candidateThroughput = this.calculateThroughput(candidateMetrics);

    const regressions = this.detectRegressions(baselineMetrics, candidateMetrics);

    const equivalentOutcomeRate =
      baselineMetrics.iterations > 0
        ? (Math.min(baselineMetrics.successCount, candidateMetrics.successCount) /
            baselineMetrics.iterations) *
          100
        : 0;

    return {
      medianDeltaMs: candidateMedian - baselineMedian,
      p95DeltaMs: candidateP95 - baselineP95,
      throughputDelta: candidateThroughput - baselineThroughput,
      regressions,
      equivalentOutcomeRate,
    };
  }

  protected calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  protected calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  protected calculateThroughput(metrics: BenchmarkMetrics): number {
    if (metrics.durations.length === 0) return 0;
    const totalDuration = metrics.durations.reduce((a, b) => a + b, 0);
    return (metrics.iterations / totalDuration) * 1000; // iterations per second
  }

  protected detectRegressions(
    baseline: BenchmarkMetrics,
    candidate: BenchmarkMetrics
  ): Regression[] {
    const regressions: Regression[] = [];

    // Duration regression
    const baselineMedian = this.calculateMedian(baseline.durations);
    const candidateMedian = this.calculateMedian(candidate.durations);
    if (candidateMedian > baselineMedian * 1.1) {
      regressions.push({
        metric: 'duration',
        baseline: baselineMedian,
        candidate: candidateMedian,
        deltaPercent: ((candidateMedian - baselineMedian) / baselineMedian) * 100,
        severity: candidateMedian > baselineMedian * 1.5 ? 'critical' : 'warning',
      });
    }

    // Memory regression
    const baselineMemory = this.calculateMedian(
      baseline.memorySnapshots.map((m) => m.heapUsedMB)
    );
    const candidateMemory = this.calculateMedian(
      candidate.memorySnapshots.map((m) => m.heapUsedMB)
    );
    if (candidateMemory > baselineMemory * 1.2) {
      regressions.push({
        metric: 'memory',
        baseline: baselineMemory,
        candidate: candidateMemory,
        deltaPercent: ((candidateMemory - baselineMemory) / baselineMemory) * 100,
        severity: candidateMemory > baselineMemory * 1.5 ? 'critical' : 'warning',
      });
    }

    // Token count regression
    const baselineTokens = this.calculateMedian(
      baseline.tokenCounts.map((t) => t.total)
    );
    const candidateTokens = this.calculateMedian(
      candidate.tokenCounts.map((t) => t.total)
    );
    if (candidateTokens > baselineTokens * 1.15) {
      regressions.push({
        metric: 'tokens',
        baseline: baselineTokens,
        candidate: candidateTokens,
        deltaPercent: ((candidateTokens - baselineTokens) / baselineTokens) * 100,
        severity: candidateTokens > baselineTokens * 1.3 ? 'critical' : 'warning',
      });
    }

    return regressions;
  }

  exportResults(format: 'json' | 'csv' = 'json'): string {
    const results = Object.fromEntries(this.results);
    if (format === 'json') {
      return JSON.stringify(results, null, 2);
    }
    // CSV format
    const headers = [
      'scenario',
      'baseline_sha',
      'median_ms',
      'p95_ms',
      'success_rate',
      'regression_count',
    ];
    const rows = Array.from(this.results.values()).map((r) => [
      r.scenario,
      r.baselineSha,
      this.calculateMedian(r.metrics.durations).toFixed(2),
      this.calculatePercentile(r.metrics.durations, 95).toFixed(2),
      `${((r.metrics.successCount / r.metrics.iterations) * 100).toFixed(1)}%`,
      r.metrics.regressionCount,
    ]);
    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  saveResultsToFile(filepath: string): void {
    const fs = require('fs');
    fs.writeFileSync(filepath, this.exportResults('json'));
  }
}

import * as os from 'os';
