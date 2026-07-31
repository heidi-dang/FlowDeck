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
