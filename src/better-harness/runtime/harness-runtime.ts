import { RunCoordinator } from "./run-coordinator";
import { EventBus, type HarnessEventType } from "./event-bus";
import { cancelRun as cancelRunAction } from "./run-cancellation";
import type { StoredRun } from "../persistence/run-store";
import { setFlowDeckStateDir } from "../persistence/harness-store";

export interface HarnessRuntimeConfig {
  projectRoot: string;
  timeoutMs?: number;
  /**
   * Optional state directory for persistence isolation.
   * When set, all runtime persistence writes go to this directory
   * instead of ~/.flowdeck/state/. The caller is responsible for
   * cleanup. Only supported for standalone/testing usage.
   */
  stateDir?: string;
}

export class HarnessRuntime {
  private coordinator: RunCoordinator;
  private config: HarnessRuntimeConfig;

  constructor(config: HarnessRuntimeConfig) {
    this.config = config;
    if (config.stateDir) {
      setFlowDeckStateDir(config.stateDir);
    }
    this.coordinator = new RunCoordinator();
  }

  getCoordinator(): RunCoordinator {
    return this.coordinator;
  }

  getEventBus(): EventBus {
    return this.coordinator.getEventBus();
  }

  subscribe(type: HarnessEventType, handler: (event: any) => void): () => void {
    return this.coordinator.getEventBus().subscribe(type, handler);
  }

  async enqueueRun(_request: { mode: string; sourceRevision?: string; collectors?: string[] }): Promise<{ runId: string; status: string }> {
    const result = await this.coordinator.enqueueRun({
      projectRoot: this.config.projectRoot,
      timeoutMs: this.config.timeoutMs,
    });
    return {
      runId: result.runId,
      status: result.status,
    };
  }

  getRun(runId: string): StoredRun | null {
    return this.coordinator.getRun(runId);
  }

  cancelRun(runId: string): boolean {
    return this.coordinator.cancelRun(runId);
  }

  async run(): Promise<{ runId: string; status: string }> {
    return this.enqueueRun({ mode: "full" });
  }

  cancel(): boolean {
    const active = this.coordinator.getActiveRun();
    if (!active) return false;
    return cancelRunAction(active.runId);
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
