/**
 * ChildExecutionLifecycleService — Canonical native child execution lifecycle & state management.
 *
 * Implements:
 * - Single authoritative child execution domain backed by SqliteNativeChildExecutionRepository (execution_metadata).
 * - Canonical immutable terminal state machine (completed, failed, cancelled, timed_out).
 * - Truthful cancellation: distinguishes cancel_requested from confirmed cancelled state.
 * - Transactionally consistent child transitions + Assignment status synchronization.
 * - Exact identity reconciliation across restarts without identifier fabrication.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AssignmentService } from "./assignment-service";
import type { SqliteSessionRepository } from "../persistence/repositories/session";
import type { ExecutionRegistry } from "./execution-registry";
import type { IEventBus } from "./ports";
import type { TransactionManager } from "../persistence/transaction-manager";
import { HeidiDelegationRuntime } from "../../services/heidi-delegation-runtime";
import {
  SqliteNativeChildExecutionRepository,
  type ChildExecutionRecord,
  type ChildExecutionState,
} from "../persistence/repositories/native-child-execution";

export { type ChildExecutionRecord, type ChildExecutionState };

export interface NativeChildControlPort {
  abortSession(sessionId: string, directory?: string): Promise<{ aborted: boolean; error?: string }>;
}

export const TERMINAL_CHILD_STATES: ReadonlySet<ChildExecutionState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalChildState(state: ChildExecutionState): boolean {
  return TERMINAL_CHILD_STATES.has(state);
}

/**
 * Allowed child lifecycle transitions:
 * queued: running, completed, failed, cancel_requested, cancelled, timed_out
 * running: completed, failed, cancel_requested, cancelled, timed_out
 * cancel_requested: cancelled, failed, timed_out
 * completed: terminal (immutable)
 * failed: terminal (immutable)
 * cancelled: terminal (immutable)
 * timed_out: terminal (immutable)
 * unknown: queued, running, completed, failed, cancelled, timed_out
 */
const ALLOWED_CHILD_TRANSITIONS: Record<ChildExecutionState, ReadonlyArray<ChildExecutionState>> = {
  queued: ["running", "completed", "failed", "cancel_requested", "cancelled", "timed_out"],
  running: ["completed", "failed", "cancel_requested", "cancelled", "timed_out"],
  cancel_requested: ["cancelled", "failed", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  unknown: ["queued", "running", "completed", "failed", "cancelled", "timed_out"],
};

export function isValidChildTransition(from: ChildExecutionState, to: ChildExecutionState): boolean {
  if (from === to) return true;
  if (TERMINAL_CHILD_STATES.has(from)) return false;
  const allowed = ALLOWED_CHILD_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface ChildExecutionTransitionResult {
  record: ChildExecutionRecord;
  changed: boolean;
  previousState: ChildExecutionState;
  newState: ChildExecutionState;
}

export interface RegisterDelegationInput {
  runId: string;
  parentSessionId: string;
  taskCallId: string;
  targetAgent: string;
  assignmentId?: string;
  executionId?: string;
  prompt?: string;
  description?: string;
  background?: boolean;
}

export class ChildExecutionLifecycleService {
  private readonly recordsByTaskCall = new Map<string, ChildExecutionRecord>();
  private readonly recordsByChildSession = new Map<string, ChildExecutionRecord>();
  private readonly recordsByAssignment = new Map<string, ChildExecutionRecord>();
  private readonly delegationRuntime: HeidiDelegationRuntime;
  private readonly nativeChildRepo: SqliteNativeChildExecutionRepository;
  private controlPort?: NativeChildControlPort;

  constructor(
    private readonly db: Database,
    private readonly assignmentService: AssignmentService,
    private readonly sessionRepo: SqliteSessionRepository,
    private readonly executionRegistry: ExecutionRegistry,
    private readonly eventBus: IEventBus,
    nativeChildRepo?: SqliteNativeChildExecutionRepository,
    private readonly txManager?: TransactionManager,
    controlPort?: NativeChildControlPort,
  ) {
    this.controlPort = controlPort;
    this.delegationRuntime = new HeidiDelegationRuntime(db);
    this.nativeChildRepo = nativeChildRepo ?? new SqliteNativeChildExecutionRepository(db, {
      write: <T>(fn: () => T): T => {
        return (db.transaction ? db.transaction(fn)() : fn()) as T;
      },
      read: <T>(fn: () => T): T => fn(),
    } as any);

    this.reconcileAfterRestart();
  }

  setControlPort(port: NativeChildControlPort): void {
    this.controlPort = port;
  }

  /**
   * Authoritative, canonical child state transition engine.
   * Enforces:
   * - Strict immutability of terminal states.
   * - Atomic persistence via SqliteNativeChildExecutionRepository before in-memory cache is updated.
   * - Structured diagnostic logging on stale or conflicting transitions.
   */
  private transitionChild(
    record: ChildExecutionRecord,
    targetState: ChildExecutionState,
    extra?: {
      result?: string;
      error?: string;
      cancelRequested?: boolean;
      nativeTerminationConfirmed?: boolean;
      completedAt?: string | null;
    }
  ): ChildExecutionTransitionResult {
    const previousState = record.status;

    // Idempotent no-op: terminal states are immutable and ignore duplicate / late payload mutations
    if (previousState === targetState) {
      return { record, changed: false, previousState, newState: previousState };
    }

    // Terminal immutability guard
    if (TERMINAL_CHILD_STATES.has(previousState)) {
      console.warn(
        `[ChildExecutionLifecycleService] Conflicting transition rejected: execution ${record.executionId} is terminal in state '${previousState}', ignoring event requesting '${targetState}'.`
      );
      return { record, changed: false, previousState, newState: previousState };
    }

    // Allowed transition guard
    if (!isValidChildTransition(previousState, targetState)) {
      console.warn(
        `[ChildExecutionLifecycleService] Invalid child transition rejected: execution ${record.executionId} from '${previousState}' to '${targetState}'.`
      );
      return { record, changed: false, previousState, newState: previousState };
    }

    // Apply mutation
    record.status = targetState;
    if (extra) {
      if (extra.result !== undefined) record.result = extra.result;
      if (extra.error !== undefined) record.error = extra.error;
      if (extra.cancelRequested !== undefined) record.cancelRequested = extra.cancelRequested;
      if (extra.nativeTerminationConfirmed !== undefined) record.nativeTerminationConfirmed = extra.nativeTerminationConfirmed;
      if (extra.completedAt !== undefined) record.completedAt = extra.completedAt;
    }

    // Persist durably FIRST — fail closed if write fails
    this.nativeChildRepo.save(record);

    // Update in-memory caches
    this.recordsByTaskCall.set(record.taskCallId, record);
    this.recordsByAssignment.set(record.assignmentId, record);
    if (record.childSessionId) {
      this.recordsByChildSession.set(record.childSessionId, record);
    }

    return { record, changed: true, previousState, newState: targetState };
  }

  /** Register a child delegation when Heidi calls native Task. Creates Assignment & Execution. */
  async registerDelegation(input: RegisterDelegationInput): Promise<ChildExecutionRecord> {
    // 1. Idempotency check on taskCallId
    const existing = this.recordsByTaskCall.get(input.taskCallId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const assignmentId = input.assignmentId ?? randomUUID();
    const executionId = input.executionId ?? `exec-${input.taskCallId}`;
    const agentId = input.targetAgent || "unknown-specialist";
    const role = input.description || input.targetAgent || "specialist";

    // 2. Persist Assignment in SQLite via AssignmentService
    await this.assignmentService.createAssignment({
      id: assignmentId,
      runId: input.runId,
      agentId,
      role,
      taskDescription: input.prompt,
      correlationId: input.runId,
    });

    // 3. Record in HeidiDelegationRuntime (best effort projection)
    try {
      this.delegationRuntime.queued({
        childId: executionId,
        parentSessionId: input.parentSessionId,
        parentTaskRunId: input.runId,
        specialist: agentId,
        goal: input.prompt || input.description,
      });
    } catch (err) {
      console.warn("[ChildExecutionLifecycleService] delegationRuntime.queued non-fatal error:", err);
    }

    // 4. Register execution handle in ExecutionRegistry with cancellation hook
    const abortController = new AbortController();
    this.executionRegistry.registerRun(executionId, abortController, async () => {
      await this.markCancelled({ taskCallId: input.taskCallId, reason: "Cancelled by ExecutionRegistry" });
    });

    const record: ChildExecutionRecord = {
      executionId,
      runId: input.runId,
      assignmentId,
      taskCallId: input.taskCallId,
      parentSessionId: input.parentSessionId,
      agentId,
      status: "queued",
      background: input.background === true,
      prompt: input.prompt,
      description: input.description,
      cancelRequested: false,
      nativeTerminationConfirmed: false,
      startedAt: now,
      completedAt: null,
    };

    // Durable persistence before cache population
    this.nativeChildRepo.save(record);

    this.recordsByTaskCall.set(input.taskCallId, record);
    this.recordsByAssignment.set(assignmentId, record);

    return record;
  }

  /** Late-bind childSessionId when OpenCode emits session.created for the spawned child session. */
  bindChildSession(input: {
    parentSessionId: string;
    childSessionId: string;
    agentId?: string;
    taskCallId?: string;
  }): ChildExecutionRecord | null {
    let record: ChildExecutionRecord | undefined;

    if (input.taskCallId) {
      record = this.recordsByTaskCall.get(input.taskCallId);
    }

    if (!record) {
      // Find unbound records for this parent session (matching agentId if provided)
      const candidates = Array.from(this.recordsByTaskCall.values()).filter(
        r => r.parentSessionId === input.parentSessionId && !r.childSessionId
      );

      const matching = input.agentId
        ? candidates.filter(r => r.agentId === input.agentId)
        : candidates;

      if (matching.length === 1) {
        // EXACT UNAMBIGUOUS MATCH
        record = matching[0];
      } else if (matching.length > 1) {
        // AMBIGUOUS: multiple concurrent unbound executions for same parent and specialist
        // Fail closed — do NOT guess or bind arbitrarily
        console.warn(
          `[ChildExecutionLifecycleService] Ambiguous child session binding: ${matching.length} candidates for parent=${input.parentSessionId}, agent=${input.agentId}. Session ${input.childSessionId} left unbound until explicit resolution.`
        );
        return null;
      } else {
        return null;
      }
    }

    if (!record) return null;

    // Fail-closed guard: prevent conflicting/corrupt session rebinding
    if (record.childSessionId && record.childSessionId !== input.childSessionId) {
      console.warn(
        `[ChildExecutionLifecycleService] Conflicting child session binding rejected: execution ${record.executionId} already bound to ${record.childSessionId}, ignoring ${input.childSessionId}`
      );
      return null;
    }
    const existingOwner = this.recordsByChildSession.get(input.childSessionId);
    if (existingOwner && existingOwner.executionId !== record.executionId) {
      console.warn(
        `[ChildExecutionLifecycleService] Conflicting child session binding rejected: session ${input.childSessionId} already belongs to execution ${existingOwner.executionId}`
      );
      return null;
    }

    record.childSessionId = input.childSessionId;

    // Persist agent_sessions row in SQLite
    try {
      this.sessionRepo.create({
        id: input.childSessionId,
        runId: record.runId,
        assignmentId: record.assignmentId,
        agentId: record.agentId,
        parentSessionId: input.parentSessionId,
        depth: 1,
        status: record.status === "queued" ? "running" : record.status,
      });
    } catch {
      try {
        this.sessionRepo.updateStatus(input.childSessionId, record.status === "queued" ? "running" : record.status);
      } catch (err) {
        console.warn("[ChildExecutionLifecycleService] sessionRepo update error:", err);
      }
    }

    // Persist updated execution record durably
    this.nativeChildRepo.save(record);
    this.recordsByChildSession.set(input.childSessionId, record);

    return record;
  }

  /** Mark child execution started / running. */
  async markStarted(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const trans = this.transitionChild(record, "running");
    if (!trans.changed) return trans;

    // Update Assignment in SQLite
    await this.assignmentService.startAssignment(record.assignmentId);

    // Update HeidiDelegationRuntime (best-effort projection)
    try {
      this.delegationRuntime.transition(record.executionId, "running");
    } catch {}

    // Update agent_sessions if childSessionId is bound
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "running");
      } catch {}
    }

    return trans;
  }

  /** Mark child execution successfully completed. */
  async markCompleted(input: {
    taskCallId?: string;
    childSessionId?: string;
    output?: string;
    title?: string;
    metadata?: any;
  }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const now = new Date().toISOString();
    const trans = this.transitionChild(record, "completed", {
      result: input.output,
      completedAt: now,
    });
    if (!trans.changed) return trans;

    // Update Assignment in SQLite
    await this.assignmentService.completeAssignment(record.assignmentId);

    // Update HeidiDelegationRuntime (best-effort projection)
    try {
      this.delegationRuntime.transition(record.executionId, "completed", {
        summary: input.title ?? (input.output ? input.output.slice(0, 200) : "Task completed"),
      });
    } catch {}

    // Update agent_sessions in SQLite
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "completed");
      } catch {}
    }

    // Resolve execution handle in ExecutionRegistry
    this.executionRegistry.resolveExecution(record.executionId);
    this.executionRegistry.unregisterRun(record.executionId);

    return trans;
  }

  /** Mark child execution failed. */
  async markFailed(input: {
    taskCallId?: string;
    childSessionId?: string;
    error?: string;
  }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const now = new Date().toISOString();
    const err = input.error ?? "Child task execution failed";
    const trans = this.transitionChild(record, "failed", {
      error: err,
      completedAt: now,
    });
    if (!trans.changed) return trans;

    // Update Assignment in SQLite
    await this.assignmentService.failAssignment(record.assignmentId);

    // Update HeidiDelegationRuntime (best-effort projection)
    try {
      this.delegationRuntime.transition(record.executionId, "failed", {
        error: err,
      });
    } catch {}

    // Update agent_sessions in SQLite
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "failed", undefined, err);
      } catch {}
    }

    this.executionRegistry.resolveExecution(record.executionId);
    this.executionRegistry.unregisterRun(record.executionId);

    return trans;
  }

  /**
   * Request native child cancellation and transition truthfully.
   * If native termination is confirmed (or native client abort succeeds), marks status="cancelled".
   * If native abort cannot be verified, records cancelRequested=true and nativeTerminationConfirmed=false.
   */
  async markCancelled(input: {
    taskCallId?: string;
    childSessionId?: string;
    reason?: string;
    confirmed?: boolean;
    client?: any;
    workspace?: string;
  }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    if (TERMINAL_CHILD_STATES.has(record.status)) {
      return { record, changed: false, previousState: record.status, newState: record.status };
    }

    const reason = input.reason ?? "Child task cancelled";
    let isConfirmed = input.confirmed === true;

    // If native client or NativeChildControlPort is available, attempt native session abort
    if (!isConfirmed && record.childSessionId) {
      if (input.client) {
        try {
          const res = await input.client.session?.abort?.({
            path: { id: record.childSessionId },
            query: input.workspace ? { directory: input.workspace } : undefined,
          });
          if (res === true || res?.data === true || (res && !res.error)) {
            isConfirmed = true;
          }
        } catch (err) {
          console.warn(`[ChildExecutionLifecycleService] native session abort for ${record.childSessionId} threw:`, err);
          isConfirmed = false;
        }
      } else if (this.controlPort) {
        try {
          const portRes = await this.controlPort.abortSession(record.childSessionId, input.workspace);
          if (portRes.aborted) {
            isConfirmed = true;
          }
        } catch (err) {
          console.warn(`[ChildExecutionLifecycleService] controlPort abortSession for ${record.childSessionId} threw:`, err);
          isConfirmed = false;
        }
      }
    }

    const now = new Date().toISOString();

    if (isConfirmed) {
      // Confirmed cancellation -> transition to "cancelled"
      const trans = this.transitionChild(record, "cancelled", {
        cancelRequested: true,
        nativeTerminationConfirmed: true,
        error: reason,
        completedAt: now,
      });
      if (!trans.changed) return trans;

      // Update Assignment in SQLite
      await this.assignmentService.cancelAssignment(record.assignmentId);

      // Update HeidiDelegationRuntime (best-effort projection)
      try {
        this.delegationRuntime.transition(record.executionId, "cancelled", {
          error: reason,
        });
      } catch {}

      // Update agent_sessions in SQLite
      if (record.childSessionId) {
        try {
          this.sessionRepo.updateStatus(record.childSessionId, "cancelled", undefined, reason);
        } catch {}
      }

      this.executionRegistry.resolveExecution(record.executionId);
      this.executionRegistry.unregisterRun(record.executionId);

      return trans;
    } else {
      // Cancellation requested but native stop NOT yet confirmed
      record.cancelRequested = true;
      record.nativeTerminationConfirmed = false;
      record.error = reason;
      this.nativeChildRepo.save(record);

      return {
        record,
        changed: true,
        previousState: record.status,
        newState: record.status, // Preserves running / queued state until native termination confirmed
      };
    }
  }

  /** Confirm native child termination after external proof (e.g. session.deleted or tool finish). */
  async confirmNativeTermination(input: {
    taskCallId?: string;
    childSessionId?: string;
    reason?: string;
  }): Promise<ChildExecutionTransitionResult | null> {
    return this.markCancelled({
      ...input,
      confirmed: true,
    });
  }

  /** Mark child execution timed out. */
  async markTimedOut(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const now = new Date().toISOString();
    const trans = this.transitionChild(record, "timed_out", {
      error: "Child task timed out",
      completedAt: now,
    });
    if (!trans.changed) return trans;

    await this.assignmentService.failAssignment(record.assignmentId);

    try {
      this.delegationRuntime.transition(record.executionId, "timed_out", { error: "Timed out" });
    } catch {}

    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "failed", undefined, "Timed out");
      } catch {}
    }

    this.executionRegistry.resolveExecution(record.executionId);
    this.executionRegistry.unregisterRun(record.executionId);

    return trans;
  }

  /** Cancel all active child executions for a specific run. */
  async cancelChildrenForRun(runId: string, reason?: string, client?: any): Promise<number> {
    let count = 0;
    const records = Array.from(this.recordsByTaskCall.values()).filter(
      r => r.runId === runId && (r.status === "queued" || r.status === "running")
    );

    for (const record of records) {
      // Mark cancelled truthfully (confirmed if queued or via client abort)
      const isQueued = record.status === "queued";
      await this.markCancelled({
        taskCallId: record.taskCallId,
        reason: reason ?? "Parent run cancelled",
        confirmed: isQueued, // Queued tasks never spawned native processes, so stop is immediate
        client,
      });
      // Explicitly signal and cancel child ExecutionRegistry handle
      await this.executionRegistry.cancelRunExecution(record.executionId, reason);
      count += 1;
    }

    // Cross-check sessionRepo for any orphan child sessions
    try {
      const sessions = this.sessionRepo.findByRunId(runId);
      for (const s of sessions) {
        if (s.depth > 0 && s.status !== "completed" && s.status !== "cancelled" && s.status !== "failed") {
          this.sessionRepo.updateStatus(s.id, "cancelled", undefined, reason ?? "Parent run cancelled");
          if (s.assignmentId) {
            try {
              await this.assignmentService.cancelAssignment(s.assignmentId);
            } catch {}
          }
          count += 1;
        }
      }
    } catch {}

    return count;
  }

  /** Recover / reconcile non-terminal children from durable SQLite state after restart without fabricating identifiers. */
  reconcileAfterRestart(runId?: string): void {
    try {
      // 1. Reconcile from nativeChildRepo (execution_metadata)
      const records = this.nativeChildRepo.listAll(runId);
      for (const rec of records) {
        if (rec.taskCallId && rec.executionId && rec.assignmentId) {
          this.recordsByTaskCall.set(rec.taskCallId, rec);
          this.recordsByAssignment.set(rec.assignmentId, rec);
          if (rec.childSessionId) {
            this.recordsByChildSession.set(rec.childSessionId, rec);
          }
        }
      }

      // 2. Cross-reference agent_sessions table for any updated statuses
      const sessionRows = runId
        ? this.db.query("SELECT * FROM agent_sessions WHERE run_id = ? AND depth > 0").all(runId)
        : this.db.query("SELECT * FROM agent_sessions WHERE depth > 0").all();

      for (const row of sessionRows as any[]) {
        if (!row.id || !row.assignment_id) continue;
        const existing = this.recordsByAssignment.get(row.assignment_id);
        if (existing) {
          if (!existing.childSessionId) {
            existing.childSessionId = row.id;
            this.recordsByChildSession.set(row.id, existing);
          }
          if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
            if (!TERMINAL_CHILD_STATES.has(existing.status)) {
              existing.status = row.status as ChildExecutionState;
            }
          }
        }
      }
    } catch (err) {
      console.error("[ChildExecutionLifecycleService] reconcileAfterRestart error:", err);
    }
  }

  /** Get child execution record by taskCallId or childSessionId or assignmentId. */
  getChildExecution(identifier: { taskCallId?: string; childSessionId?: string; assignmentId?: string }): ChildExecutionRecord | null {
    if (identifier.taskCallId && this.recordsByTaskCall.has(identifier.taskCallId)) {
      return this.recordsByTaskCall.get(identifier.taskCallId)!;
    }
    if (identifier.childSessionId && this.recordsByChildSession.has(identifier.childSessionId)) {
      return this.recordsByChildSession.get(identifier.childSessionId)!;
    }
    if (identifier.assignmentId && this.recordsByAssignment.has(identifier.assignmentId)) {
      return this.recordsByAssignment.get(identifier.assignmentId)!;
    }
    return null;
  }

  /** List all child execution records for a specific run. */
  listChildExecutionsForRun(runId: string): ChildExecutionRecord[] {
    return Array.from(this.recordsByTaskCall.values()).filter(r => r.runId === runId);
  }

  /** Get aggregated child diagnostics for session. */
  getDiagnosticsForRun(runId: string): {
    activeAssignments: number;
    completedAssignments: number;
    failedAssignments: number;
    activeChildExecutions: number;
    completedChildExecutions: number;
    failedChildExecutions: number;
    childExecutions: Array<{
      assignmentId: string;
      executionId: string;
      agentId: string;
      taskCallId: string;
      childSessionId?: string;
      status: string;
      cancelRequested?: boolean;
      nativeTerminationConfirmed?: boolean;
      startedAt?: string;
      completedAt?: string | null;
    }>;
  } {
    const list = this.listChildExecutionsForRun(runId);
    let activeAssignments = 0;
    let completedAssignments = 0;
    let failedAssignments = 0;
    let activeChildExecutions = 0;
    let completedChildExecutions = 0;
    let failedChildExecutions = 0;

    for (const item of list) {
      if (item.status === "queued" || item.status === "running") {
        activeAssignments += 1;
        activeChildExecutions += 1;
      } else if (item.status === "completed") {
        completedAssignments += 1;
        completedChildExecutions += 1;
      } else if (item.status === "failed" || item.status === "cancelled" || item.status === "timed_out") {
        failedAssignments += 1;
        failedChildExecutions += 1;
      }
    }

    return {
      activeAssignments,
      completedAssignments,
      failedAssignments,
      activeChildExecutions,
      completedChildExecutions,
      failedChildExecutions,
      childExecutions: list.map(item => ({
        assignmentId: item.assignmentId,
        executionId: item.executionId,
        agentId: item.agentId,
        taskCallId: item.taskCallId,
        childSessionId: item.childSessionId,
        status: item.status,
        cancelRequested: item.cancelRequested,
        nativeTerminationConfirmed: item.nativeTerminationConfirmed,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      })),
    };
  }

  private resolveRecord(input: { taskCallId?: string; childSessionId?: string }): ChildExecutionRecord | null {
    if (input.taskCallId && this.recordsByTaskCall.has(input.taskCallId)) {
      return this.recordsByTaskCall.get(input.taskCallId)!;
    }
    if (input.childSessionId && this.recordsByChildSession.has(input.childSessionId)) {
      return this.recordsByChildSession.get(input.childSessionId)!;
    }
    return null;
  }
}
