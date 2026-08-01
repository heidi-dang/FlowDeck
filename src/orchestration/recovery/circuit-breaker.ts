/**
 * Circuit breaker for preventing cascading failures.
 *
 * States:
 * - CLOSED: normal operation, failures are counted
 * - OPEN: circuit is tripped, requests fail fast
 * - HALF_OPEN: after resetTimeout, one test request is allowed
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenRequests: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenRequests: 1,
};

export interface CircuitBreakerMetrics {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt?: Date;
  readonly lastStateChangeAt: Date;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
}

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureAt?: Date;
  private lastStateChangeAt = new Date();
  private totalSuccesses = 0;
  private totalFailures = 0;
  private halfOpenSuccesses = 0;
  private halfOpenAttempts = 0;

  constructor(
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
  ) {}

  get state(): CircuitState {
    this.evaluateStateTransition();
    return this._state;
  }

  private evaluateStateTransition(): void {
    if (this._state === "open") {
      const now = Date.now();
      const elapsed = now - this.lastStateChangeAt.getTime();
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transitionTo("half_open");
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    this._state = newState;
    this.lastStateChangeAt = new Date();

    if (newState === "closed") {
      this.failureCount = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenAttempts = 0;
    } else if (newState === "half_open") {
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;
    }
  }

  recordSuccess(): void {
    if (this._state === "closed") {
      this.totalSuccesses++;
      this.failureCount = 0;
    } else if (this._state === "half_open") {
      this.totalSuccesses++;
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.transitionTo("closed");
      }
    }
  }

  recordFailure(): void {
    this.totalFailures++;
    this.lastFailureAt = new Date();

    if (this._state === "closed") {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo("open");
      }
    } else if (this._state === "half_open") {
      this.transitionTo("open");
    }
  }

  isOpen(): boolean {
    this.evaluateStateTransition();
    return this._state === "open";
  }

  canExecute(): boolean {
    this.evaluateStateTransition();
    return this._state !== "open";
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this._state,
      failureCount: this.failureCount,
      lastFailureAt: this.lastFailureAt,
      lastStateChangeAt: this.lastStateChangeAt,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
    };
  }

  reset(): void {
    this.transitionTo("closed");
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.lastFailureAt = undefined;
  }
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  getOrCreate(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(config);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAllMetrics(): Map<string, CircuitBreakerMetrics> {
    const result = new Map<string, CircuitBreakerMetrics>();
    for (const [name, breaker] of this.breakers) {
      result.set(name, breaker.getMetrics());
    }
    return result;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
