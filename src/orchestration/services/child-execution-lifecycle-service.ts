/**
 * ChildExecutionLifecycleService — Authoritative FlowDeck native child execution and assignment lifecycle manager.
 *
 * Bridges native OpenCode Task/background child invocations to FlowDeck:
 * - Run -> Assignment linkage (created before/at delegation boundary)
 * - TaskCall -> Execution identity correlation
 * - Child session late-binding
 * - Authoritative state transitions (queued -> running -> completed | failed | cancelled | timed_out)
 * - Result & error ingestion
 * - Stale event protection (never regress completed -> failed/cancelled)
 * - Canonical cancellation propagation from parent Run
 * - Cold restart reconciliation from SQLite
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AssignmentService } from "./assignment-service";
import type { SqliteSessionRepository } from "../persistence/repositories/session";
import type { ExecutionRegistry } from "./execution-registry";
import type { IEventBus } from "./ports";

import { HeidiDelegationRuntime } from "../../services/heidi-delegation-runtime";

export type ChildExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown";

export interface ChildExecutionRecord {
  executionId: string;
  runId: string;
  assignmentId: string;
  taskCallId: string;
  parentSessionId: string;
  childSessionId?: string;
  agentId: string;
  status: ChildExecutionState;
  background: boolean;
  prompt?: string;
  description?: string;
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string | null;
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

  constructor(
    private readonly db: Database,
    private readonly assignmentService: AssignmentService,
    private readonly sessionRepo: SqliteSessionRepository,
    private readonly executionRegistry: ExecutionRegistry,
    private readonly eventBus: IEventBus,
  ) {
    this.delegationRuntime = new HeidiDelegationRuntime(db);
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

    // 3. Record in HeidiDelegationRuntime (SQLite heidi_delegation_activity)
    try {
      this.delegationRuntime.queued({
        childId: executionId,
        parentSessionId: input.parentSessionId,
        parentTaskRunId: input.runId,
        specialist: agentId,
        goal: input.prompt || input.description,
      });
    } catch {
      // Safe fallback
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
      startedAt: now,
      completedAt: null,
    };

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
      // Find the most recent unbound record for this parent session (matching agentId if provided)
      const candidates = Array.from(this.recordsByTaskCall.values()).filter(
        r => r.parentSessionId === input.parentSessionId && !r.childSessionId
      );
      if (input.agentId) {
        record = candidates.find(r => r.agentId === input.agentId) ?? candidates[0];
      } else {
        record = candidates[0];
      }
    }

    if (!record) return null;

    // Fail-closed guard: prevent conflicting/corrupt session rebinding
    if (record.childSessionId && record.childSessionId !== input.childSessionId) {
      console.warn(`[ChildExecutionLifecycleService] Conflicting child session binding rejected: execution ${record.executionId} already bound to ${record.childSessionId}, ignoring ${input.childSessionId}`);
      return null;
    }
    const existingOwner = this.recordsByChildSession.get(input.childSessionId);
    if (existingOwner && existingOwner.executionId !== record.executionId) {
      console.warn(`[ChildExecutionLifecycleService] Conflicting child session binding rejected: session ${input.childSessionId} already belongs to execution ${existingOwner.executionId}`);
      return null;
    }

    record.childSessionId = input.childSessionId;
    this.recordsByChildSession.set(input.childSessionId, record);

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
      // Session might already exist, update status
      try {
        this.sessionRepo.updateStatus(input.childSessionId, record.status === "queued" ? "running" : record.status);
      } catch {}
    }

    return record;
  }

  /** Mark child execution started / running. */
  async markStarted(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionRecord | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    if (record.status !== "queued") {
      return record;
    }

    record.status = "running";

    // Update Assignment in SQLite
    try {
      await this.assignmentService.startAssignment(record.assignmentId);
    } catch {}

    // Update HeidiDelegationRuntime
    try {
      this.delegationRuntime.transition(record.executionId, "running");
    } catch {}

    // Update agent_sessions if childSessionId is bound
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "running");
      } catch {}
    }

    return record;
  }

  /** Mark child execution successfully completed. */
  async markCompleted(input: {
    taskCallId?: string;
    childSessionId?: string;
    output?: string;
    title?: string;
    metadata?: any;
  }): Promise<ChildExecutionRecord | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    // Idempotency: already completed
    if (record.status === "completed") {
      return record;
    }

    // Guard: Do not overwrite cancelled or failed state with late completion
    if (record.status === "cancelled" || record.status === "failed") {
      return record;
    }

    const now = new Date().toISOString();
    record.status = "completed";
    record.result = input.output;
    record.completedAt = now;

    // Update Assignment in SQLite
    try {
      await this.assignmentService.completeAssignment(record.assignmentId);
    } catch {}

    // Update HeidiDelegationRuntime
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

    return record;
  }

  /** Mark child execution failed. */
  async markFailed(input: {
    taskCallId?: string;
    childSessionId?: string;
    error?: string;
  }): Promise<ChildExecutionRecord | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    // Guard: NEVER regress completed -> failed on stale late failure events
    if (record.status === "completed") {
      return record;
    }

    if (record.status === "failed") {
      return record;
    }

    const now = new Date().toISOString();
    record.status = "failed";
    record.error = input.error ?? "Child task execution failed";
    record.completedAt = now;

    // Update Assignment in SQLite
    try {
      await this.assignmentService.failAssignment(record.assignmentId);
    } catch {}

    // Update HeidiDelegationRuntime
    try {
      this.delegationRuntime.transition(record.executionId, "failed", {
        error: record.error,
      });
    } catch {}

    // Update agent_sessions in SQLite
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "failed", undefined, record.error);
      } catch {}
    }

    this.executionRegistry.resolveExecution(record.executionId);
    this.executionRegistry.unregisterRun(record.executionId);

    return record;
  }

  /** Mark child execution cancelled. */
  async markCancelled(input: {
    taskCallId?: string;
    childSessionId?: string;
    reason?: string;
  }): Promise<ChildExecutionRecord | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    if (record.status === "completed" || record.status === "cancelled") {
      return record;
    }

    const now = new Date().toISOString();
    record.status = "cancelled";
    record.error = input.reason ?? "Child task cancelled";
    record.completedAt = now;

    // Update Assignment in SQLite
    try {
      await this.assignmentService.cancelAssignment(record.assignmentId);
    } catch {}

    // Update HeidiDelegationRuntime
    try {
      this.delegationRuntime.transition(record.executionId, "cancelled", {
        error: record.error,
      });
    } catch {}

    // Update agent_sessions in SQLite
    if (record.childSessionId) {
      try {
        this.sessionRepo.updateStatus(record.childSessionId, "cancelled", undefined, record.error);
      } catch {}
    }

    this.executionRegistry.resolveExecution(record.executionId);
    this.executionRegistry.unregisterRun(record.executionId);

    return record;
  }

  /** Mark child execution timed out. */
  async markTimedOut(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionRecord | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    if (record.status === "completed" || record.status === "cancelled" || record.status === "failed") {
      return record;
    }

    const now = new Date().toISOString();
    record.status = "timed_out";
    record.error = "Child task timed out";
    record.completedAt = now;

    try {
      await this.assignmentService.failAssignment(record.assignmentId);
    } catch {}

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

    return record;
  }

  /** Cancel all active child executions for a specific run (called when RunService.cancelRun is executed). */
  async cancelChildrenForRun(runId: string, reason?: string): Promise<number> {
    let count = 0;
    const records = Array.from(this.recordsByTaskCall.values()).filter(
      r => r.runId === runId && (r.status === "queued" || r.status === "running")
    );

    for (const record of records) {
      await this.markCancelled({ taskCallId: record.taskCallId, reason: reason ?? "Parent run cancelled" });
      count += 1;
    }

    // Also query SQLite for any orphan child sessions under this run that might not be in memory
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

  /** Recover / reconcile non-terminal children from SQLite after restart without fabricating success. */
  reconcileAfterRestart(runId?: string): void {
    try {
      const query = runId
        ? this.db.query("SELECT * FROM agent_sessions WHERE run_id = ? AND depth > 0").all(runId)
        : this.db.query("SELECT * FROM agent_sessions WHERE depth > 0").all();

      for (const row of query as any[]) {
        if (!row.id || !row.assignment_id) continue;
        const status: ChildExecutionState =
          row.status === "completed" ? "completed" :
          row.status === "failed" ? "failed" :
          row.status === "cancelled" ? "cancelled" :
          "running";

        const record: ChildExecutionRecord = {
          executionId: `exec-${row.id}`,
          runId: row.run_id,
          assignmentId: row.assignment_id,
          taskCallId: `call-recovered-${row.id}`,
          parentSessionId: row.parent_session_id ?? "unknown",
          childSessionId: row.id,
          agentId: row.agent_id,
          status,
          background: false,
          startedAt: row.started_at ?? new Date().toISOString(),
          completedAt: row.completed_at,
        };

        this.recordsByChildSession.set(row.id, record);
        this.recordsByAssignment.set(row.assignment_id, record);
        this.recordsByTaskCall.set(record.taskCallId, record);
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
