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
  cancelRequested?: boolean;
  startedAt: string;
  completedAt?: string | null;
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

  constructor(
    private readonly db: Database,
    private readonly assignmentService: AssignmentService,
    private readonly sessionRepo: SqliteSessionRepository,
    private readonly executionRegistry: ExecutionRegistry,
    private readonly eventBus: IEventBus,
  ) {
    this.delegationRuntime = new HeidiDelegationRuntime(db);
    this.reconcileAfterRestart();
  }

  /** Persist child execution record in SQLite execution_metadata table. */
  private persistRecord(record: ChildExecutionRecord): void {
    const key = `child_exec:${record.taskCallId}`;
    const val = JSON.stringify(record);
    this.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
    ).run(
      `meta-${record.executionId}`,
      record.runId,
      record.childSessionId ?? null,
      key,
      val
    );
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
      startedAt: now,
      completedAt: null,
    };

    this.recordsByTaskCall.set(input.taskCallId, record);
    this.recordsByAssignment.set(assignmentId, record);

    // Persist durably
    this.persistRecord(record);

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
      try {
        this.sessionRepo.updateStatus(input.childSessionId, record.status === "queued" ? "running" : record.status);
      } catch (err) {
        console.warn("[ChildExecutionLifecycleService] sessionRepo update error:", err);
      }
    }

    // Persist updated execution record
    this.persistRecord(record);

    return record;
  }

  /** Mark child execution started / running. */
  async markStarted(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const previousState = record.status;
    if (record.status !== "queued") {
      return { record, changed: false, previousState, newState: record.status };
    }

    record.status = "running";

    // Update Assignment in SQLite
    await this.assignmentService.startAssignment(record.assignmentId);

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

    this.persistRecord(record);

    return { record, changed: true, previousState, newState: "running" };
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

    const previousState = record.status;

    // Idempotency: already completed
    if (record.status === "completed") {
      return { record, changed: false, previousState, newState: "completed" };
    }

    // Guard: Do not overwrite cancelled or failed state with late completion
    if (record.status === "cancelled" || record.status === "failed") {
      return { record, changed: false, previousState, newState: record.status };
    }

    const now = new Date().toISOString();
    record.status = "completed";
    record.result = input.output;
    record.completedAt = now;

    // Update Assignment in SQLite
    await this.assignmentService.completeAssignment(record.assignmentId);

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

    this.persistRecord(record);

    return { record, changed: true, previousState, newState: "completed" };
  }

  /** Mark child execution failed. */
  async markFailed(input: {
    taskCallId?: string;
    childSessionId?: string;
    error?: string;
  }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const previousState = record.status;

    // Guard: NEVER regress completed -> failed on stale late failure events
    if (record.status === "completed") {
      return { record, changed: false, previousState, newState: "completed" };
    }

    if (record.status === "failed") {
      return { record, changed: false, previousState, newState: "failed" };
    }

    const now = new Date().toISOString();
    record.status = "failed";
    record.error = input.error ?? "Child task execution failed";
    record.completedAt = now;

    // Update Assignment in SQLite
    await this.assignmentService.failAssignment(record.assignmentId);

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

    this.persistRecord(record);

    return { record, changed: true, previousState, newState: "failed" };
  }

  /** Mark child execution cancelled. */
  async markCancelled(input: {
    taskCallId?: string;
    childSessionId?: string;
    reason?: string;
  }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const previousState = record.status;

    if (record.status === "completed" || record.status === "cancelled") {
      return { record, changed: false, previousState, newState: record.status };
    }

    const now = new Date().toISOString();
    record.status = "cancelled";
    record.cancelRequested = true;
    record.error = input.reason ?? "Child task cancelled";
    record.completedAt = now;

    // Update Assignment in SQLite
    await this.assignmentService.cancelAssignment(record.assignmentId);

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

    this.persistRecord(record);

    return { record, changed: true, previousState, newState: "cancelled" };
  }

  /** Mark child execution timed out. */
  async markTimedOut(input: { taskCallId?: string; childSessionId?: string }): Promise<ChildExecutionTransitionResult | null> {
    const record = this.resolveRecord(input);
    if (!record) return null;

    const previousState = record.status;

    if (record.status === "completed" || record.status === "cancelled" || record.status === "failed") {
      return { record, changed: false, previousState, newState: record.status };
    }

    const now = new Date().toISOString();
    record.status = "timed_out";
    record.error = "Child task timed out";
    record.completedAt = now;

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

    this.persistRecord(record);

    return { record, changed: true, previousState, newState: "timed_out" };
  }

  /** Cancel all active child executions for a specific run. */
  async cancelChildrenForRun(runId: string, reason?: string): Promise<number> {
    let count = 0;
    const records = Array.from(this.recordsByTaskCall.values()).filter(
      r => r.runId === runId && (r.status === "queued" || r.status === "running")
    );

    for (const record of records) {
      await this.markCancelled({ taskCallId: record.taskCallId, reason: reason ?? "Parent run cancelled" });
      count += 1;
    }

    // Also query SQLite for any orphan child sessions under this run
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
      // 1. Reconcile from execution_metadata (which holds the exact original taskCallId, executionId, assignmentId, background, parentSessionId)
      const metaRows = runId
        ? this.db.query("SELECT * FROM execution_metadata WHERE run_id = ? AND key LIKE 'child_exec:%'").all(runId)
        : this.db.query("SELECT * FROM execution_metadata WHERE key LIKE 'child_exec:%'").all();

      for (const row of metaRows as any[]) {
        try {
          const rec = JSON.parse(row.value) as ChildExecutionRecord;
          if (rec.taskCallId && rec.executionId && rec.assignmentId) {
            this.recordsByTaskCall.set(rec.taskCallId, rec);
            this.recordsByAssignment.set(rec.assignmentId, rec);
            if (rec.childSessionId) {
              this.recordsByChildSession.set(rec.childSessionId, rec);
            }
          }
        } catch {}
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
            existing.status = row.status as ChildExecutionState;
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
