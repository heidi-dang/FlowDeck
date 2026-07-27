import { RunCoordinator } from "./run-coordinator";
import { EventBus, type HarnessEventType } from "./event-bus";
import { cancelRun } from "./run-cancellation";

export interface HarnessRuntimeConfig {
  projectRoot: string;
  timeoutMs?: number;
}

export class HarnessRuntime {
  private coordinator: RunCoordinator;
  private config: HarnessRuntimeConfig;

  constructor(config: HarnessRuntimeConfig) {
    this.config = config;
    this.coordinator = new RunCoordinator();
  }

  getEventBus(): EventBus {
    return this.coordinator.getEventBus();
  }

  subscribe(type: HarnessEventType, handler: (event: any) => void): () => void {
    return this.coordinator.getEventBus().subscribe(type, handler);
  }

  async run(): Promise<{ runId: string; status: string }> {
    const result = await this.coordinator.startRun({
      projectRoot: this.config.projectRoot,
      timeoutMs: this.config.timeoutMs,
    });
    return {
      runId: result.runId,
      status: result.status,
    };
  }

  cancel(): boolean {
    const active = this.coordinator.getActiveRun();
    if (!active) return false;
    return cancelRun(active.runId);
  }

  getStatus(): { active: boolean; runId?: string; status?: string; stage?: string } {
    const active = this.coordinator.getActiveRun();
    if (!active) return { active: false };
    return {
      active: active.status === "queued" || active.status === "running",
      runId: active.runId,
      status: active.status,
      stage: active.stage,
    };
  }
}
