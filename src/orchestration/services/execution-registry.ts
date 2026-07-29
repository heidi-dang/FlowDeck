import { OrchestrationError, ErrorCodes } from "../types";

export interface ActiveExecutionHandle {
  runId: string;
  abortController: AbortController;
  cleanupFns: Array<() => Promise<void> | void>;
  startedAt: string;
}

export class ExecutionRegistry {
  private readonly activeHandles = new Map<string, ActiveExecutionHandle>();
  private readonly executedCleanups = new Set<string>();

  /** Register an active run execution with its AbortController and optional cleanup function */
  registerRun(runId: string, abortController?: AbortController, cleanupFn?: () => Promise<void> | void): ActiveExecutionHandle {
    let handle = this.activeHandles.get(runId);
    if (!handle) {
      handle = {
        runId,
        abortController: abortController ?? new AbortController(),
        cleanupFns: [],
        startedAt: new Date().toISOString(),
      };
      this.activeHandles.set(runId, handle);
    } else if (abortController) {
      handle.abortController = abortController;
    }

    if (cleanupFn) {
      handle.cleanupFns.push(cleanupFn);
    }

    return handle;
  }

  /** Retrieve the active execution handle for a run */
  getHandle(runId: string): ActiveExecutionHandle | undefined {
    return this.activeHandles.get(runId);
  }

  /** Check if a run has an active execution handle */
  hasActiveRun(runId: string): boolean {
    return this.activeHandles.has(runId);
  }

  /** Signal cancellation to active child execution, execute cleanup within bounded timeout */
  async cancelRunExecution(runId: string, reason?: string, timeoutMs: number = 5000): Promise<{ cancelled: boolean; cleanupErrors: Error[]; timedOut: boolean }> {
    const handle = this.activeHandles.get(runId);
    if (!handle) {
      return { cancelled: false, cleanupErrors: [], timedOut: false };
    }

    if (!handle.abortController.signal.aborted) {
      handle.abortController.abort(reason ?? "Run cancellation requested");
    }

    const cleanupErrors: Error[] = [];
    let timedOut = false;

    if (!this.executedCleanups.has(runId)) {
      this.executedCleanups.add(runId);

      const runAllCleanups = async () => {
        for (const fn of handle.cleanupFns) {
          try {
            await Promise.resolve(fn());
          } catch (err) {
            cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          cleanupErrors.push(OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR, {
            message: `Cancellation cleanup for run ${runId} timed out after ${timeoutMs}ms`,
          }));
          resolve({ timedOut: true });
        }, timeoutMs);
      });

      try {
        await Promise.race([runAllCleanups().then(() => ({ timedOut: false })), timeoutPromise]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    this.activeHandles.delete(runId);

    return { cancelled: true, cleanupErrors, timedOut };
  }

  /** Unregister active execution handle upon normal completion or failure */
  unregisterRun(runId: string): void {
    this.activeHandles.delete(runId);
    this.executedCleanups.delete(runId);
  }

  /** List all currently active run IDs */
  getActiveRunIds(): string[] {
    return Array.from(this.activeHandles.keys());
  }

  /** Clear all handles and bookkeeping (for testing) */
  clear(): void {
    this.activeHandles.clear();
    this.executedCleanups.clear();
  }
}