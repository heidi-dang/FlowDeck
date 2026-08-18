/**
 * TaskPhaseManager — isolate materially different task phases (Requirement J).
 *
 * The original repo audit produced its report, then a new implementation task
 * was injected into the same session. A major new task must NOT inherit stale
 * runtime-control state from the previous task, but session ancestry must be
 * preserved. On a true manual/new-task transition:
 *
 *   RESET: loop guard incidents, semantic convergence state, watchdog state,
 *          recovery generation, task ownership, verification evidence, token
 *          progress epoch, route decision.
 *   PRESERVE: session ancestry (never cleared), verified *session* facts that
 *          are task-independent, coordinator provenance.
 */

export interface TaskPhaseBoundary {
  phase: number;
  labels: string[];
  resetLoopIncidents: boolean;
  resetSemanticConvergence: boolean;
  resetWatchdog: boolean;
  resetRecoveryGeneration: boolean;
  resetRouteDecision: boolean;
  resetVerificationEvidence: boolean;
  resetTokenEpoch: boolean;
  preserveSessionAncestry: true;
  preserveCoordinatorProvenance: true;
}

export class TaskPhaseManager {
  private phaseBySession = new Map<string, TaskPhaseBoundary>();
  private evidenceByTask = new Map<string, unknown[]>();

  /**
   * Begin a new task phase for a session. Every key resets except session
   * ancestry and coordinator provenance, which are explicitly preserved.
   */
  beginNewTaskPhase(sessionID: string, taskId: string, labels: string[] = []): TaskPhaseBoundary {
    const boundary: TaskPhaseBoundary = {
      phase: (this.phaseBySession.get(sessionID)?.phase ?? 0) + 1,
      labels,
      resetLoopIncidents: true,
      resetSemanticConvergence: true,
      resetWatchdog: true,
      resetRecoveryGeneration: true,
      resetRouteDecision: true,
      resetVerificationEvidence: true,
      resetTokenEpoch: true,
      preserveSessionAncestry: true,
      preserveCoordinatorProvenance: true,
    };
    this.phaseBySession.set(sessionID, boundary);
    this.evidenceByTask.set(taskId, []);
    return boundary;
  }

  getCurrentPhase(sessionID: string): TaskPhaseBoundary | undefined {
    return this.phaseBySession.get(sessionID);
  }

  addEvidence(taskId: string, evidence: unknown): void {
    const list = this.evidenceByTask.get(taskId) ?? [];
    list.push(evidence);
    this.evidenceByTask.set(taskId, list);
  }

  getEvidence(taskId: string): unknown[] {
    return this.evidenceByTask.get(taskId) ?? [];
  }

  clearEvidence(taskId: string): void {
    this.evidenceByTask.delete(taskId);
  }

  clearSession(sessionID: string): void {
    this.phaseBySession.delete(sessionID);
  }

  clearAll(): void {
    this.phaseBySession.clear();
    this.evidenceByTask.clear();
  }
}

export const taskPhaseManager = new TaskPhaseManager()
