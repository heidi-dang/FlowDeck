import { OrchestrationError, ErrorCodes } from "../types";

export interface ActiveExecutionHandle {
  runId: string;
  abortController: AbortController;
  cleanupFns: Array<() => Promise<void> | void>;
  startedAt: string;
  /** Resolves when execution actually stops */
  executionPromise: Promise<void> | null;
  /** Call when execution terminates */
  resolveExecution: (() => void) | null;
  /** Separate controller for cleanup phase */
  cleanupController: AbortController | null;
  /** Resources owned by this execution that must be disposed */
  ownedResources: Set<{ dispose(): Promise<void> | void }>;
}

export class ExecutionRegistry {
  private readonly activeHandles = new Map<string, ActiveExecutionHandle>();
  private readonly executedCleanups = new Set<string>();
  private readonly resolvedExecutions = new Set<string>();

  /** Register an active run execution with its AbortController and optional cleanup function */
  registerRun(runId: string, abortController?: AbortController, cleanupFn?: () => Promise<void> | void): ActiveExecutionHandle {
    let handle = this.activeHandles.get(runId);
    if (!handle) {
      let resolveExecution: (() => void) | null = null;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      handle = {
        runId,
        abortController: abortController ?? new AbortController(),
        cleanupFns: [],
        startedAt: new Date().toISOString(),
        executionPromise,
        resolveExecution,
        cleanupController: null,
        ownedResources: new Set(),
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

  /** Called by executor when execution naturally stops */
  resolveExecution(runId: string): void {
    const handle = this.activeHandles.get(runId);
    if (handle && handle.resolveExecution) {
      handle.resolveExecution();
      handle.resolveExecution = null;
      this.resolvedExecutions.add(runId);
    }
  }

  /** Add a resource that must be disposed when the execution is cleaned up */
  addResource(runId: string, resource: { dispose(): Promise<void> | void }): void {
    const handle = this.activeHandles.get(runId);
    if (handle) {
      handle.ownedResources.add(resource);
    }
  }

  /** Signal cancellation to active child execution, execute cleanup within bounded timeout */
  async cancelRunExecution(runId: string, reason?: string, timeoutMs: number = 5000): Promise<{ cancelled: boolean; cleanupErrors: Error[]; timedOut: boolean }> {
    const handle = this.activeHandles.get(runId);
    if (!handle) {
      return { cancelled: false, cleanupErrors: [], timedOut: false };
    }

    // Signal abort to the running execution
    if (!handle.abortController.signal.aborted) {
      handle.abortController.abort(reason ?? "Run cancellation requested");
    }

    // Wait for execution to actually stop (with timeout)
    let executionTimedOut = false;
    if (handle.executionPromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<true>((resolve) => {
        timer = setTimeout(() => {
          executionTimedOut = true;
          resolve(true);
        }, timeoutMs);
      });

      try {
        await Promise.race([handle.executionPromise, timeoutPromise]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    // If execution timed out, mark it as resolved in our tracking and do NOT unregister
    if (executionTimedOut) {
      if (handle.resolveExecution) {
        handle.resolveExecution();
        handle.resolveExecution = null;
      }
      this.resolvedExecutions.add(runId);
      return { cancelled: false, cleanupErrors: [], timedOut: true };
    }

    // Execution actually stopped — proceed with cleanup
    const cleanupErrors: Error[] = [];
    let cleanupTimedOut = false;

    if (!this.executedCleanups.has(runId)) {
      this.executedCleanups.add(runId);

      const runAllCleanups = async () => {
        // Dispose owned resources
        for (const resource of handle.ownedResources) {
          try {
            await Promise.resolve(resource.dispose());
          } catch (err) {
            cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        handle.ownedResources.clear();

        // Run registered cleanup functions
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
          cleanupTimedOut = true;
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

    // Only unregister if cleanup didn't time out
    if (!cleanupTimedOut) {
      this.activeHandles.delete(runId);
      this.resolvedExecutions.delete(runId);
    }

    return { cancelled: true, cleanupErrors, timedOut: cleanupTimedOut };
  }

  /** Unregister active execution handle upon normal completion or failure */
  unregisterRun(runId: string, force: boolean = false): void {
    if (force || this.resolvedExecutions.has(runId) || !this.activeHandles.has(runId)) {
      this.activeHandles.delete(runId);
      this.resolvedExecutions.delete(runId);
      this.executedCleanups.delete(runId);
    }
  }

  /** List all currently active run IDs */
  getActiveRunIds(): string[] {
    return Array.from(this.activeHandles.keys());
  }

  /** Clear all handles and bookkeeping (for testing) */
  clear(): void {
    this.activeHandles.clear();
    this.executedCleanups.clear();
    this.resolvedExecutions.clear();
  }
}