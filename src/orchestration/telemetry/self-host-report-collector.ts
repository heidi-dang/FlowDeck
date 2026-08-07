import type {
  SelfHostReport,
  Identity,
  Orchestration,
  ToolMetrics,
  PerformanceMetrics,
  StabilityMetrics,
  Comparison,
  FinalVerdict,
} from "./self-host-report-schema.js";
import { createEmptyReport, SCHEMA_VERSION } from "./self-host-report-schema.js";
import { normalizeSpecialistTokenMetrics, normalizeToolMetrics } from "./metric-normalizer.js";

// ── Collector state ────────────────────────────────────────────────────────────

interface CollectorConfig {
  taskId?: string;
  developer?: string;
  branch?: string;
  baseSha?: string;
  startingSha?: string;
  campaignId?: string;
  mainSessionId?: string;
  childSessionIds?: string[];
  pr?: string;
  flowdeckHarnessIdentity?: string;
  candidateIdentity?: string;
}

interface RawMetricsInput {
  tokenMetrics?: Record<string, Record<string, unknown>>;
  toolMetrics?: Record<string, unknown>;
  performanceMetrics?: Partial<PerformanceMetrics>;
  stabilityMetrics?: Partial<StabilityMetrics>;
  orchestration?: Partial<Orchestration>;
  comparison?: Partial<Comparison>;
  finalVerdict?: Partial<FinalVerdict>;
}

// ── Collector ─────────────────────────────────────────────────────────────────

export class SelfHostReportCollector {
  private report: SelfHostReport;
  private config: CollectorConfig;

  constructor(config: CollectorConfig = {}) {
    this.report = createEmptyReport();
    this.config = config;
  }

  /**
   * Sets identity fields on the report.
   */
  setIdentity(identity: Partial<Identity>): this {
    this.report.identity = {
      ...this.report.identity,
      ...identity,
      taskId: identity.taskId ?? this.config.taskId,
      developer: identity.developer ?? this.config.developer,
      branch: identity.branch ?? this.config.branch,
      baseSha: identity.baseSha ?? this.config.baseSha,
      startingSha: identity.startingSha ?? this.config.startingSha,
      campaignId: identity.campaignId ?? this.config.campaignId,
      mainSessionId: identity.mainSessionId ?? this.config.mainSessionId,
      childSessionIds: identity.childSessionIds ?? this.config.childSessionIds,
      pr: identity.pr ?? this.config.pr,
      flowdeckHarnessIdentity: identity.flowdeckHarnessIdentity ?? this.config.flowdeckHarnessIdentity,
      candidateIdentity: identity.candidateIdentity ?? this.config.candidateIdentity,
    };
    return this;
  }

  /**
   * Sets orchestration data on the report.
   */
  setOrchestration(orchestration: Partial<Orchestration>): this {
    this.report.orchestration = {
      ...this.report.orchestration,
      ...orchestration,
    };
    return this;
  }

  /**
   * Collects and normalizes token metrics.
   */
  setTokenMetrics(
    perSpecialistRaw: Record<string, Record<string, unknown>>,
  ): this {
    this.report.tokenMetrics = normalizeSpecialistTokenMetrics(perSpecialistRaw);
    return this;
  }

  /**
   * Collects and normalizes tool metrics.
   */
  setToolMetrics(raw: Record<string, unknown>): this {
    this.report.toolMetrics = normalizeToolMetrics(raw);
    return this;
  }

  /**
   * Sets raw (pre-normalized) tool metrics directly.
   */
  setToolMetricsRaw(metrics: ToolMetrics): this {
    this.report.toolMetrics = metrics;
    return this;
  }

  /**
   * Sets performance metrics.
   */
  setPerformance(metrics: Partial<PerformanceMetrics>): this {
    this.report.performance = {
      ...this.report.performance,
      ...metrics,
    };
    return this;
  }

  /**
   * Sets stability metrics.
   */
  setStability(metrics: Partial<StabilityMetrics>): this {
    this.report.stability = {
      ...this.report.stability,
      ...metrics,
    };
    return this;
  }

  /**
   * Sets comparison data.
   */
  setComparison(comparison: Partial<Comparison>): this {
    this.report.comparison = {
      ...this.report.comparison,
      ...comparison,
    };
    return this;
  }

  /**
   * Sets the final verdict.
   */
  setFinalVerdict(verdict: Partial<FinalVerdict>): this {
    this.report.finalVerdict = {
      ...this.report.finalVerdict,
      ...verdict,
    };
    return this;
  }

  /**
   * Collects all raw metrics in one call.
   */
  collectRaw(input: RawMetricsInput): this {
    if (input.orchestration) this.setOrchestration(input.orchestration);
    if (input.tokenMetrics) this.setTokenMetrics(input.tokenMetrics);
    if (input.toolMetrics) this.setToolMetrics(input.toolMetrics);
    if (input.performanceMetrics) this.setPerformance(input.performanceMetrics);
    if (input.stabilityMetrics) this.setStability(input.stabilityMetrics);
    if (input.comparison) this.setComparison(input.comparison);
    if (input.finalVerdict) this.setFinalVerdict(input.finalVerdict);
    return this;
  }

  /**
   * Builds and returns the finalized report.
   */
  build(): SelfHostReport {
    return {
      ...this.report,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Resets the collector to empty state.
   */
  reset(): this {
    this.report = createEmptyReport();
    return this;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCollector(config?: CollectorConfig): SelfHostReportCollector {
  return new SelfHostReportCollector(config);
}
