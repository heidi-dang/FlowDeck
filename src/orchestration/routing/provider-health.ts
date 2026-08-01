/**
 * Provider health monitoring for routing decisions.
 *
 * Tracks latency, error rates, and circuit breaker state per provider
 * to inform routing decisions and enable fallback selection.
 */

import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../recovery/circuit-breaker";

export interface HealthMetrics {
  readonly p50Latency: number;
  readonly p95Latency: number;
  readonly p99Latency: number;
  readonly errorRate: number;
  readonly timeoutRate: number;
}

export interface ProviderHealth {
  readonly provider: string;
  readonly queueTimeout: number;
  readonly firstTokenTimeout: number;
  readonly totalTimeout: number;
  readonly healthScore: number; // 0-1
  readonly circuitBreakerOpen: boolean;
  readonly fallbackList: readonly string[];
}

interface LatencySample {
  readonly timestamp: number;
  readonly latencyMs: number;
}

interface ProviderState {
  readonly provider: string;
  readonly latencySamples: LatencySample[];
  readonly errorCount: number;
  readonly timeoutCount: number;
  readonly totalRequests: number;
  readonly circuitBreaker: CircuitBreaker;
  readonly fallbackList: readonly string[];
  readonly lastHealthCheck: Date;
}

const HEALTH_SCORE_WEIGHTS = {
  latencyWeight: 0.4,
  errorWeight: 0.4,
  timeoutWeight: 0.2,
};

export class ProviderHealthMonitor {
  private providers = new Map<string, ProviderState>();
  private readonly windowMs: number;
  private readonly maxSamples: number;

  constructor(windowMs = 60_000, maxSamples = 1000) {
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
  }

  recordLatency(provider: string, latencyMs: number): void {
    const state = this.getOrCreateState(provider);
    const now = Date.now();

    const newSamples = [
      ...state.latencySamples.filter((s) => now - s.timestamp < this.windowMs),
      { timestamp: now, latencyMs },
    ].slice(-this.maxSamples);

    this.providers.set(provider, {
      ...state,
      latencySamples: newSamples,
      totalRequests: state.totalRequests + 1,
    });
  }

  recordError(provider: string, isTimeout = false): void {
    const state = this.getOrCreateState(provider);

    this.providers.set(provider, {
      ...state,
      errorCount: state.errorCount + (isTimeout ? 0 : 1),
      timeoutCount: state.timeoutCount + (isTimeout ? 1 : 0),
      totalRequests: state.totalRequests + 1,
    });

    // Record in circuit breaker
    if (isTimeout) {
      state.circuitBreaker.recordFailure();
    } else {
      state.circuitBreaker.recordFailure();
    }
  }

  recordSuccess(provider: string): void {
    const state = this.getOrCreateState(provider);
    state.circuitBreaker.recordSuccess();
  }

  getHealth(provider: string): ProviderHealth | undefined {
    const state = this.providers.get(provider);
    if (!state) return undefined;

    const metrics = this.calculateMetrics(state);
    const healthScore = this.calculateHealthScore(metrics);

    return {
      provider,
      queueTimeout: this.estimateQueueTimeout(metrics),
      firstTokenTimeout: metrics.p50Latency * 2,
      totalTimeout: metrics.p99Latency * 3,
      healthScore,
      circuitBreakerOpen: state.circuitBreaker.isOpen(),
      fallbackList: state.fallbackList,
    };
  }

  isHealthy(provider: string): boolean {
    const state = this.providers.get(provider);
    if (!state) return false;
    return !state.circuitBreaker.isOpen() && this.getHealthScore(state) > 0.3;
  }

  getFallbackList(provider: string): readonly string[] {
    const state = this.providers.get(provider);
    return state?.fallbackList ?? [];
  }

  getAllHealth(): Map<string, ProviderHealth> {
    const result = new Map<string, ProviderHealth>();
    for (const provider of this.providers.keys()) {
      const health = this.getHealth(provider);
      if (health) {
        result.set(provider, health);
      }
    }
    return result;
  }

  setFallbackList(provider: string, fallbacks: readonly string[]): void {
    const state = this.getOrCreateState(provider);
    this.providers.set(provider, {
      ...state,
      fallbackList: fallbacks,
    });
  }

  getMetrics(provider: string): HealthMetrics | undefined {
    const state = this.providers.get(provider);
    if (!state) return undefined;
    return this.calculateMetrics(state);
  }

  private getOrCreateState(provider: string): ProviderState {
    let state = this.providers.get(provider);
    if (!state) {
      state = {
        provider,
        latencySamples: [],
        errorCount: 0,
        timeoutCount: 0,
        totalRequests: 0,
        circuitBreaker: new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG),
        fallbackList: [],
        lastHealthCheck: new Date(),
      };
      this.providers.set(provider, state);
    }
    return state;
  }

  private calculateMetrics(state: ProviderState): HealthMetrics {
    const now = Date.now();
    const recentSamples = state.latencySamples.filter((s) => now - s.timestamp < this.windowMs);

    if (recentSamples.length === 0) {
      return {
        p50Latency: 0,
        p95Latency: 0,
        p99Latency: 0,
        errorRate: state.totalRequests > 0 ? state.errorCount / state.totalRequests : 0,
        timeoutRate: state.totalRequests > 0 ? state.timeoutCount / state.totalRequests : 0,
      };
    }

    const sorted = [...recentSamples].sort((a, b) => a.latencyMs - b.latencyMs);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      p50Latency: sorted[p50Index]?.latencyMs ?? 0,
      p95Latency: sorted[p95Index]?.latencyMs ?? 0,
      p99Latency: sorted[p99Index]?.latencyMs ?? 0,
      errorRate: state.totalRequests > 0 ? state.errorCount / state.totalRequests : 0,
      timeoutRate: state.totalRequests > 0 ? state.timeoutCount / state.totalRequests : 0,
    };
  }

  private calculateHealthScore(metrics: HealthMetrics): number {
    // Latency score (lower is better)
    const latencyScore = Math.max(0, 1 - metrics.p50Latency / 5000); // 5s = 0 score

    // Error score (lower error rate is better)
    const errorScore = Math.max(0, 1 - metrics.errorRate * 10); // 10% errors = 0 score

    // Timeout score (lower timeout rate is better)
    const timeoutScore = Math.max(0, 1 - metrics.timeoutRate * 20); // 5% timeouts = 0 score

    return (
      latencyScore * HEALTH_SCORE_WEIGHTS.latencyWeight +
      errorScore * HEALTH_SCORE_WEIGHTS.errorWeight +
      timeoutScore * HEALTH_SCORE_WEIGHTS.timeoutWeight
    );
  }

  private getHealthScore(state: ProviderState): number {
    const metrics = this.calculateMetrics(state);
    return this.calculateHealthScore(metrics);
  }

  private estimateQueueTimeout(metrics: HealthMetrics): number {
    // Estimate queue timeout based on recent latency distribution
    return metrics.p95Latency * 1.5;
  }
}
