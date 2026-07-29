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

  /** Signal cancellation to active child execution, execute cleanup, and wait for completion */
  async cancelRunExecution(runId: string, reason?: string, timeoutMs: number = 5000): Promise<{ cancelled: boolean; cleanupError?: Error }> {
    const handle = this.activeHandles.get(runId);
    if (!handle) {
      return { cancelled: false };
    }

    // 1. Signal cancellation on abort controller
    if (!handle.abortController.signal.aborted) {
      handle.abortController.abort(reason ?? "Run cancellation requested");
    }

    // 2. Execute registered cleanup functions idempotently
    let cleanupError: Error | undefined;
    if (!this.executedCleanups.has(runId)) {
      this.executedCleanups.add(runId);
      for (const fn of handle.cleanupFns) {
        try {
          await Promise.resolve(fn());
        } catch (err) {
          cleanupError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // 3. Wait for bounded cancellation completion
    const cancellationPromise = new Promise<{ cancelled: boolean; cleanupError?: Error }>((resolve) => {
      resolve({ cancelled: true, cleanupError });
    });

    const timeoutPromise = new Promise<{ cancelled: boolean; cleanupError?: Error }>((_, reject) => {
      setTimeout(() => reject(OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR, {
        message: `Cancellation cleanup for run ${runId} timed out after ${timeoutMs}ms`,
      })), timeoutMs);
    });

    try {
      const result = await Promise.race([cancellationPromise, timeoutPromise]);
      return result;
    } finally {
      // 4. Remove active handle ONLY after cleanup completes
      this.activeHandles.delete(runId);
    }
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

  /** Clear all handles (for testing) */
  clear(): void {
    this.activeHandles.clear();
    this.executedCleanups.clear();
  }
}
