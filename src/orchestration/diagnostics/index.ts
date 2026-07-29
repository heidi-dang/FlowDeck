import type { HealthService, HealthStatus } from "../services/health-service";
import type { OrchestrationMetrics } from "../metrics";
import type { StructuredLogger } from "../logging";
import type { SseManager } from "../streaming/sse-manager";
import type { WebSocketManager } from "../streaming/websocket-manager";
import type { EventSubscriptionManager } from "../streaming/event-subscription";
import type { IEventRepository, IOutboxRepository } from "../services/ports";

export interface DiagnosticsReport {
  service: string;
  version: string;
  timestamp: string;
  health: Partial<HealthStatus>;
  eventBacklog: number;
  subscriberBacklog: number;
  subscriberCount: number;
  activeConnections: number;
  replayStatus: string;
  workerHealth: string;
  metrics: {
    commandsDispatched: number;
    eventsPublished: number;
    activeRuns: number;
    deadLetterCount: number;
  };
}

export class DiagnosticsService {
  constructor(
    private readonly healthService: HealthService,
    private readonly metrics: OrchestrationMetrics,
    private readonly logger: StructuredLogger,
    private readonly sseManager: SseManager,
    private readonly wsManager: WebSocketManager,
    private readonly subscriptionManager: EventSubscriptionManager,
    private readonly eventRepo?: IEventRepository,
    private readonly outboxRepo?: IOutboxRepository,
  ) {}

  async generateReport(): Promise<DiagnosticsReport> {
    const health = await this.healthService.checkHealth();
    const eventBacklog = this.outboxRepo ? await this.outboxRepo.count({ status: "pending" as any }) : 0;
    const subscriberCount = this.subscriptionManager.getSubscriberCount();

    this.logger.info("Diagnostics report generated", {
      component: "diagnostics",
      metadata: { subscriberCount, eventBacklog, activeConnections: this.sseManager.getClientCount() },
    });

    return {
      service: "orchestration",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      health: { status: health.status, checks: health.checks },
      eventBacklog,
      subscriberBacklog: subscriberCount > 0 ? Math.max(0, eventBacklog - 100) : 0,
      subscriberCount,
      activeConnections: this.sseManager.getClientCount() + this.wsManager.getClientCount(),
      replayStatus: "idle",
      workerHealth: "healthy",
      metrics: {
        commandsDispatched: this.metrics.commandsDispatched.get(),
        eventsPublished: this.metrics.eventsPublished.get(),
        activeRuns: this.metrics.activeRuns.get(),
        deadLetterCount: this.metrics.deadLetterCount.get(),
      },
    };
  }

  async getServiceHealth(): Promise<{ service: string; status: string; uptime: number; timestamp: string }> {
    const liveness = await this.healthService.checkLiveness();
    return {
      service: "orchestration",
      status: liveness.status,
      uptime: liveness.uptime,
      timestamp: new Date().toISOString(),
    };
  }

  async getDatabaseConnectivity(): Promise<{ connected: boolean; latencyMs?: number }> {
    return { connected: true }; // Placeholder
  }

  async getMigrationVersion(): Promise<{ version: string; latest: string }> {
    return { version: "0.1.0", latest: "0.1.0" };
  }

  async getEventBacklog(): Promise<{ pending: number; total: number }> {
    const pending = this.outboxRepo ? await this.outboxRepo.count({ status: "pending" as any }) : 0;
    return { pending, total: 0 };
  }

  async getReplayStatus(): Promise<{ status: string; activeReplays: number }> {
    return { status: "idle", activeReplays: 0 };
  }

  async getWorkerHealth(): Promise<{ healthy: boolean; workers: number; status: string }> {
    return { healthy: true, workers: 1, status: "healthy" };
  }
}
