import type { RedundancyReport } from "./redundancy-detector.js";
import type { PerformanceMetrics, ToolMetrics, StabilityMetrics } from "./self-host-report-schema.js";

// ── Historical data types ─────────────────────────────────────────────────────

export interface HistoricalData {
  redundancyReports: RedundancyReport[];
  performanceHistory: PerformanceSnapshot[];
  toolMetricsHistory: ToolMetrics[];
  stabilityHistory: StabilitySnapshot[];
  durationDays: number;
}

export interface PerformanceSnapshot {
  timestamp: number;
  tokensPerSecond?: number;
  contextUtilization?: number;
  averageLatencyMs?: number;
  costPerTask?: number;
}

export interface StabilitySnapshot {
  timestamp: number;
  taskSuccessRate: number;
  toolErrorRate: number;
  specialistErrorRate: number;
}

// ── Policy recommendation types ───────────────────────────────────────────────

export type PolicyRecommendationType =
  | "model_escalation"
  | "model_deescalation"
  | "specialist_add"
  | "specialist_remove"
  | "batch_enable"
  | "cache_enable";

export interface PolicyRecommendation {
  type: PolicyRecommendationType;
  confidence: number;
  evidence: string[];
  proposedChange: string;
  shadowModeRequired: boolean;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
  REDUNDANT_QUERY_THRESHOLD: 5,
  DUPLICATE_CONTEXT_THRESHOLD: 3,
  ERROR_RATE_THRESHOLD: 0.15,
  LATENCY_P95_MS_THRESHOLD: 5000,
  COST_INCREASE_THRESHOLD: 0.2,
  SPECIALIST_ERROR_RATE_THRESHOLD: 0.25,
  MIN_SAMPLES_FOR_CONFIDENCE: 5,
} as const;

// ── Adaptive Recommendation Engine ────────────────────────────────────────────

export class AdaptiveRecommendationEngine {
  evaluate(historicalData: HistoricalData): PolicyRecommendation[] {
    const recommendations: PolicyRecommendation[] = [];

    if (historicalData.redundancyReports.length < THRESHOLDS.MIN_SAMPLES_FOR_CONFIDENCE) {
      return recommendations;
    }

    recommendations.push(...this.evaluateRedundancyPatterns(historicalData));
    recommendations.push(...this.evaluatePerformancePatterns(historicalData));
    recommendations.push(...this.evaluateStabilityPatterns(historicalData));

    return recommendations.sort((a, b) => b.confidence - a.confidence);
  }

  private evaluateRedundancyPatterns(data: HistoricalData): PolicyRecommendation[] {
    const recommendations: PolicyRecommendation[] = [];

    let totalRepeatedQueries = 0;
    let totalDuplicateContext = 0;
    let totalUnnecessarySpecialists = 0;
    let samplesWithRedundancy = 0;

    for (const report of data.redundancyReports) {
      const hasRedundancy =
        report.repeatedToolQueries.length > 0 ||
        report.duplicateContext.length > 0 ||
        report.unnecessarySpecialists.length > 0;

      if (hasRedundancy) {
        samplesWithRedundancy++;
        totalRepeatedQueries += report.repeatedToolQueries.reduce((sum, q) => sum + q.count, 0);
        totalDuplicateContext += report.duplicateContext.reduce((sum, c) => sum + c.count, 0);
        totalUnnecessarySpecialists += report.unnecessarySpecialists.length;
      }
    }

    const redundancyRate = samplesWithRedundancy / data.redundancyReports.length;

    if (redundancyRate > 0.6) {
      if (totalDuplicateContext > THRESHOLDS.DUPLICATE_CONTEXT_THRESHOLD * data.durationDays) {
        recommendations.push({
          type: "cache_enable",
          confidence: Math.min(0.9, redundancyRate),
          evidence: [
            `${totalDuplicateContext} duplicate context items across ${samplesWithRedundancy} reports`,
            `Redundancy rate: ${(redundancyRate * 100).toFixed(1)}%`,
          ],
          proposedChange: "Enable context deduplication caching to reduce repeated context additions",
          shadowModeRequired: true,
        });
      }

      if (totalRepeatedQueries > THRESHOLDS.REDUNDANT_QUERY_THRESHOLD * data.durationDays) {
        recommendations.push({
          type: "cache_enable",
          confidence: Math.min(0.85, redundancyRate * 0.9),
          evidence: [
            `${totalRepeatedQueries} repeated tool queries across ${samplesWithRedundancy} reports`,
            `Average: ${(totalRepeatedQueries / data.durationDays).toFixed(1)} redundant queries/day`,
          ],
          proposedChange: "Enable tool query result caching for repeated queries",
          shadowModeRequired: true,
        });
      }

      if (totalUnnecessarySpecialists > data.durationDays * 0.5) {
        recommendations.push({
          type: "specialist_remove",
          confidence: Math.min(0.75, redundancyRate * 0.8),
          evidence: [
            `${totalUnnecessarySpecialists} unnecessary specialist calls detected`,
            `Rate: ${(totalUnnecessarySpecialists / data.durationDays).toFixed(1)} per day`,
          ],
          proposedChange: "Review and potentially remove underperforming specialists",
          shadowModeRequired: true,
        });
      }
    }

    return recommendations;
  }

  private evaluatePerformancePatterns(data: HistoricalData): PolicyRecommendation[] {
    const recommendations: PolicyRecommendation[] = [];

    const avgLatency = this.averageLatency(data.performanceHistory);
    const latencyTrend = this.calculateTrend(
      data.performanceHistory.map((p) => ({ timestamp: p.timestamp, value: p.averageLatencyMs ?? 0 }))
    );

    if (avgLatency > THRESHOLDS.LATENCY_P95_MS_THRESHOLD && latencyTrend > 0) {
      recommendations.push({
        type: "model_escalation",
        confidence: Math.min(0.8, 1 - THRESHOLDS.LATENCY_P95_MS_THRESHOLD / avgLatency),
        evidence: [
          `Average latency: ${avgLatency.toFixed(0)}ms (threshold: ${THRESHOLDS.LATENCY_P95_MS_THRESHOLD}ms)`,
          `Trend: ${latencyTrend > 0 ? "increasing" : "stable"}`,
        ],
        proposedChange: "Consider escalating to a faster model to reduce latency",
        shadowModeRequired: true,
      });
    }

    const avgCost = this.averageCost(data.performanceHistory);
    const costTrend = this.calculateTrend(
      data.performanceHistory.map((p) => ({ timestamp: p.timestamp, value: p.costPerTask ?? 0 }))
    );

    if (avgCost > 0 && costTrend < 0) {
      const deescalationConfidence = Math.min(0.75, Math.abs(costTrend) * 10);
      if (deescalationConfidence > 0.4) {
        recommendations.push({
          type: "model_deescalation",
          confidence: deescalationConfidence,
          evidence: [
            `Average cost per task: $${avgCost.toFixed(4)}`,
            `Cost trend: decreasing at ${Math.abs(costTrend * 100).toFixed(1)}% per snapshot`,
          ],
          proposedChange: "Consider deescalating to a more cost-effective model",
          shadowModeRequired: true,
        });
      }
    }

    return recommendations;
  }

  private evaluateStabilityPatterns(data: HistoricalData): PolicyRecommendation[] {
    const recommendations: PolicyRecommendation[] = [];

    const avgToolErrorRate = this.weightedAverage(
      data.stabilityHistory.map((s) => s.toolErrorRate),
      data.stabilityHistory.map((_, i) => i + 1)
    );

    if (avgToolErrorRate > THRESHOLDS.ERROR_RATE_THRESHOLD) {
      recommendations.push({
        type: "cache_enable",
        confidence: Math.min(0.7, 1 - avgToolErrorRate),
        evidence: [
          `Average tool error rate: ${(avgToolErrorRate * 100).toFixed(1)}% (threshold: ${THRESHOLDS.ERROR_RATE_THRESHOLD * 100}%)`,
        ],
        proposedChange: "Enable tool call retry caching to handle transient failures",
        shadowModeRequired: true,
      });
    }

    const avgSpecialistErrorRate = this.weightedAverage(
      data.stabilityHistory.map((s) => s.specialistErrorRate),
      data.stabilityHistory.map((_, i) => i + 1)
    );

    if (avgSpecialistErrorRate > THRESHOLDS.SPECIALIST_ERROR_RATE_THRESHOLD) {
      recommendations.push({
        type: "specialist_remove",
        confidence: Math.min(0.75, 1 - avgSpecialistErrorRate),
        evidence: [
          `Average specialist error rate: ${(avgSpecialistErrorRate * 100).toFixed(1)}% (threshold: ${THRESHOLDS.SPECIALIST_ERROR_RATE_THRESHOLD * 100}%)`,
        ],
        proposedChange: "Review and remove underperforming specialists with high error rates",
        shadowModeRequired: true,
      });
    }

    return recommendations;
  }

  private averageLatency(snapshots: PerformanceSnapshot[]): number {
    const withLatency = snapshots.filter((s) => s.averageLatencyMs !== undefined);
    if (withLatency.length === 0) return 0;
    return withLatency.reduce((sum, s) => sum + (s.averageLatencyMs ?? 0), 0) / withLatency.length;
  }

  private averageCost(snapshots: PerformanceSnapshot[]): number {
    const withCost = snapshots.filter((s) => s.costPerTask !== undefined);
    if (withCost.length === 0) return 0;
    return withCost.reduce((sum, s) => sum + (s.costPerTask ?? 0), 0) / withCost.length;
  }

  private calculateTrend(
    points: Array<{ timestamp: number; value: number }>
  ): number {
    if (points.length < 2) return 0;

    const sorted = points.sort((a, b) => a.timestamp - b.timestamp);
    const n = sorted.length;
    const sumX = sorted.reduce((sum, p) => sum + p.timestamp, 0);
    const sumY = sorted.reduce((sum, p) => sum + p.value, 0);
    const sumXY = sorted.reduce((sum, p) => sum + p.timestamp * p.value, 0);
    const sumX2 = sorted.reduce((sum, p) => sum + p.timestamp * p.timestamp, 0);

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const avgValue = sumY / n;

    return avgValue !== 0 ? slope / avgValue : 0;
  }

  private weightedAverage(values: number[], weights: number[]): number {
    if (values.length === 0 || weights.length !== values.length) return 0;
    const sumWeighted = values.reduce((sum, v, i) => sum + v * weights[i], 0);
    const sumWeights = weights.reduce((sum, w) => sum + w, 0);
    return sumWeights !== 0 ? sumWeighted / sumWeights : 0;
  }
}
