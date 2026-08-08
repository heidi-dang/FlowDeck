import type { Database } from "bun:sqlite";
import type { IDeliverySink, IReplayRepository } from "./ports";
import type { OutboxWorker } from "./outbox-worker";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  timestamp: string;
  checks: HealthCheck[];
  uptime: number;
}

export interface HealthCheck {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  latencyMs?: number;
}

export interface DependencyChecker {
  check(name: string): Promise<HealthCheck>;
}

export class HealthService {
  private readonly startTime = Date.now();
  private checkers: Map<string, DependencyChecker> = new Map();

  constructor(private readonly version: string = "0.1.0") {}

  registerChecker(name: string, checker: DependencyChecker): void {
    this.checkers.set(name, checker);
  }

  async checkHealth(): Promise<HealthStatus> {
    const checks: HealthCheck[] = [];
    let overall: "healthy" | "degraded" | "unhealthy" = "healthy";

    for (const [name, checker] of this.checkers) {
      try {
        const result = await checker.check(name);
        checks.push(result);
        if (result.status === "unhealthy") overall = "unhealthy";
        else if (result.status === "degraded" && overall === "healthy") overall = "degraded";
      } catch {
        checks.push({ name, status: "unhealthy", message: "Checker threw error" });
        overall = "unhealthy";
      }
    }

    return {
      status: overall,
      version: this.version,
      timestamp: new Date().toISOString(),
      checks,
      uptime: Date.now() - this.startTime,
    };
  }

  async checkReadiness(): Promise<HealthStatus> {
    return this.checkHealth();
  }

  async checkLiveness(): Promise<{ status: string; uptime: number }> {
    return { status: "alive", uptime: Date.now() - this.startTime };
  }

  getMachineReadableHealth(): Record<string, unknown> {
    return {
      service: "orchestration",
      status: "unknown",
      uptimeMs: Date.now() - this.startTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

export class SqliteDbChecker implements DependencyChecker {
  constructor(private readonly db: Database) {}

  async check(name: string): Promise<HealthCheck> {
    const start = Date.now();
    try {
      this.db.query("SELECT 1").get();
      const latencyMs = Date.now() - start;
      return {
        name,
        status: "healthy",
        latencyMs,
      };
    } catch (err) {
      return {
        name,
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }
}

export class OutboxWorkerChecker implements DependencyChecker {
  constructor(
    private readonly worker: OutboxWorker,
    private readonly deliverySink: IDeliverySink,
  ) {}

  async check(name: string): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const isRunning = this.worker.isRunning;
      const pendingCount = await this.deliverySink.countByStatus("pending");
      const latencyMs = Date.now() - start;
      return {
        name,
        status: "healthy",
        message: `Worker is ${isRunning ? "running" : "stopped"}. Pending outbox count: ${pendingCount}`,
        latencyMs,
      };
    } catch (err) {
      return {
        name,
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }
}

export class ReplayServiceChecker implements DependencyChecker {
  constructor(private readonly replayRepo: IReplayRepository) {}

  async check(name: string): Promise<HealthCheck> {
    const start = Date.now();
    try {
      await this.replayRepo.count();
      const latencyMs = Date.now() - start;
      return {
        name,
        status: "healthy",
        latencyMs,
      };
    } catch (err) {
      return {
        name,
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }
}
