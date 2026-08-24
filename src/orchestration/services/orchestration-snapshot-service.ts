/**
 * OrchestrationSnapshotService — Read-only projection over authoritative FlowDeck repositories.
 *
 * Assembles a point-in-time snapshot for a Run by composing:
 * - task_runs (durable phase, aggregateVersion, strategy)
 * - routing_decision (executionClass, goal)
 * - assignments (work items, status, isRequired, isSatisfied, attempt counts)
 * - native child executions (active, completed, failed, cancelRequested)
 * - progress_observations (noProgressCount, stall results, evidence/repository deltas)
 * - verification state
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { TaskRunsRepository } from "../persistence/repositories/task-run";
import type { SqliteRoutingDecisionRepository } from "../routing/sqlite-store";
import type { SqliteAssignmentRepo } from "../composition";
import type { SqliteNativeChildExecutionRepository } from "../persistence/repositories/native-child-execution";
import type { ProgressObservationService } from "./progress-observation-service";
import type { SqliteSessionRepository } from "../persistence/repositories/session";
import type { OrchestrationPhase } from "../types/runs";
import type { AssignmentStatus } from "../types/assignments";

export interface WorkItemSnapshot {
  id: string;
  role: string;
  agentId: string;
  status: AssignmentStatus;
  isRequired: boolean;
  isSatisfied: boolean;
  attempts: number;
  evidenceIds: string[];
  lastActionFingerprint?: string;
  lastResultFingerprint?: string;
  blockedReason?: string;
}

export interface OrchestrationSnapshot {
  runId: string;
  sessionId: string;
  executionClass?: string;
  phase: OrchestrationPhase;
  aggregateVersion: number;
  currentWorkItemId?: string;
  currentAssignmentId?: string;
  currentExecutionId?: string;
  workItems: WorkItemSnapshot[];
  progress: {
    noProgressCount: number;
    lastProgressAt?: string;
    lastProgressReason?: string;
    stalled: boolean;
    stallReasons: string[];
    lastEvidenceDelta: number;
    lastRepositoryDelta: number;
  };
  childState: {
    active: number;
    activeRequired: number;
    activeOptional: number;
    completed: number;
    failed: number;
    failedRequired: number;
    failedOptional: number;
    cancelRequested: number;
  };
  lifecycleBlocks: {
    cancellationPending: boolean;
    unresolvedDeferredReplacement: boolean;
  };
  verificationState?: {
    lastVerificationHash?: string;
  };
  terminalState?: {
    isTerminal: boolean;
    status: string;
  };
}

export class OrchestrationSnapshotService {
  constructor(
    private readonly db: Database,
    private readonly taskRunRepo: TaskRunsRepository,
    private readonly routingDecisionRepo: SqliteRoutingDecisionRepository,
    private readonly assignmentRepo: SqliteAssignmentRepo,
    private readonly nativeChildRepo: SqliteNativeChildExecutionRepository,
    private readonly progressService: ProgressObservationService,
    private readonly sessionRepo: SqliteSessionRepository,
  ) {}

  computeStateFingerprint(runId: string, sessionId?: string): string | null {
    const snap = this.getSnapshot(runId, sessionId);
    if (!snap) return null;
    const repositoryArtifacts = this.db.query(
      `SELECT af.assignment_id, af.file_path, af.change_type, COALESCE(af.content_hash, '') AS content_hash
       FROM assignment_files af
       INNER JOIN assignments a ON a.id = af.assignment_id
       WHERE a.run_id = ?
       ORDER BY af.assignment_id, af.file_path, af.change_type, af.id`,
    ).all(runId);
    const assignmentResults = this.db.query(
      `SELECT ar.id, ar.assignment_id, ar.step_number, ar.status,
              COALESCE(ar.tests_passed, 0) AS tests_passed,
              COALESCE(ar.tests_failed, 0) AS tests_failed,
              COALESCE(ar.output_summary, '') AS output_summary,
              COALESCE(ar.error_output, '') AS error_output,
              COALESCE(ar.completed_at, '') AS completed_at
       FROM assignment_results ar
       INNER JOIN assignments a ON a.id = ar.assignment_id
       WHERE a.run_id = ?
       ORDER BY ar.assignment_id, ar.step_number, ar.id`,
    ).all(runId);
    const runEvidence = this.db.query(
      `SELECT e.id, e.evidence_type, e.source, COALESCE(e.source_id, '') AS source_id,
              e.content_hash, e.sha, COALESCE(el.status, 'current') AS lifecycle_status
       FROM evidence e
       LEFT JOIN evidence_lifecycle el ON el.evidence_id = e.id
       WHERE e.run_id = ?
       ORDER BY e.id`,
    ).all(runId);
    const state = {
      runId: snap.runId,
      aggregateVersion: snap.aggregateVersion,
      phase: snap.phase,
      currentWorkItemId: snap.currentWorkItemId ?? "",
      workItems: snap.workItems.map(item => ({
        id: item.id,
        status: item.status,
        isRequired: item.isRequired,
        isSatisfied: item.isSatisfied,
        evidenceIds: [...item.evidenceIds].sort(),
        lastResultFingerprint: item.lastResultFingerprint ?? "",
      })),
      childState: snap.childState,
      lifecycleBlocks: snap.lifecycleBlocks,
      repositoryArtifacts,
      assignmentResults,
      runEvidence,
      progress: {
        lastRepositoryDelta: snap.progress.lastRepositoryDelta,
        lastEvidenceDelta: snap.progress.lastEvidenceDelta,
      },
    };
    return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
  }

  getSnapshot(runId: string, sessionId?: string): OrchestrationSnapshot | null {
    const taskRun = this.taskRunRepo.findById(runId);
    if (!taskRun) return null;

    // 1. Resolve Session ID
    let resolvedSessionId = sessionId;
    if (!resolvedSessionId) {
      const sessions = this.sessionRepo.findByRunId(runId);
      const rootSession = sessions.find(s => s.depth === 0) ?? sessions[0];
      resolvedSessionId = rootSession?.id ?? "unknown-session";
    }

    // 2. Resolve Routing Decision
    const decision = this.routingDecisionRepo.getLatestDecisionForRun(runId);
    const executionClass = decision?.strategy;

    // 3. Resolve Work Items (Assignments)
    const assignmentRows = this.db.query("SELECT * FROM assignments WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(runId) as Record<string, unknown>[];
    const childRecords = this.nativeChildRepo.listAll(runId);
    const childByAssignment = new Map(childRecords.map(c => [c.assignmentId, c]));

    // Verification may only consume explicit, completed command/test evidence.
    // A child-session result or successful tool exit is not verification evidence.
    const assignmentResultRows = this.db.query(
      `SELECT ar.*
       FROM assignment_results ar
       INNER JOIN assignments a ON a.id = ar.assignment_id
       WHERE a.run_id = ?`,
    ).all(runId) as Record<string, unknown>[];
    const verificationEvidenceByAssignment = new Map<string, string[]>();
    for (const result of assignmentResultRows) {
      const isCompleted = result.completed_at !== null && result.completed_at !== undefined;
      const passedTests = Number(result.tests_passed ?? 0) > 0;
      const failedTests = Number(result.tests_failed ?? 0) === 0;
      const resultStatus = String(result.status ?? "").toLowerCase();
      if (isCompleted && passedTests && failedTests && (resultStatus === "passed" || resultStatus === "completed")) {
        const assignmentId = String(result.assignment_id);
        const evidence = verificationEvidenceByAssignment.get(assignmentId) ?? [];
        evidence.push(`assignment_result:${String(result.id)}`);
        verificationEvidenceByAssignment.set(assignmentId, evidence);
      }
    }

    // Read attempt records from execution_metadata for this run if any
    const attemptRows = this.db.query("SELECT * FROM execution_metadata WHERE run_id = ? AND key LIKE 'attempt:%'").all(runId) as Record<string, unknown>[];
    const attemptsByAssignment = new Map<string, any[]>();
    for (const row of attemptRows) {
      try {
        const att = JSON.parse(row.value as string);
        if (att.assignmentId) {
          const list = attemptsByAssignment.get(att.assignmentId) ?? [];
          list.push(att);
          attemptsByAssignment.set(att.assignmentId, list);
        }
      } catch {}
    }

    const workItems: WorkItemSnapshot[] = assignmentRows.map(row => {
      const id = String(row.id);
      const child = childByAssignment.get(id);
      const attempts = attemptsByAssignment.get(id) ?? [];
      const latestAttempt = attempts[attempts.length - 1];
      const isRequired = (row.is_required as number | undefined) !== 0;
      const status = (row.status === "running" ? "in_progress" : String(row.status)) as AssignmentStatus;
      const isSatisfied = status === "completed" || (status === "skipped" && !isRequired);

      return {
        id,
        role: String(row.description ?? ""),
        agentId: String(row.agent_id ?? ""),
        status,
        isRequired,
        isSatisfied,
        attempts: Math.max(attempts.length, row.status === "in_progress" || row.status === "running" ? 1 : 0),
        evidenceIds: verificationEvidenceByAssignment.get(id) ?? [],
        lastActionFingerprint: latestAttempt?.actionFingerprint,
        lastResultFingerprint: latestAttempt?.resultFingerprint,
        blockedReason: row.status === "failed" ? String(child?.error ?? "") : undefined,
      };
    });

    // 4. Identify Current Work Item
    let currentWorkItem = workItems.find(w => w.status === "in_progress" || (w.status as string) === "running" || w.status === "assigned");
    if (!currentWorkItem) {
      currentWorkItem = workItems.find(w => w.status === "pending");
    }

    const currentChild = currentWorkItem ? childByAssignment.get(currentWorkItem.id) : undefined;

    // 5. Child Execution State Counts (Required vs Optional aware)
    const assignmentMap = new Map(assignmentRows.map(a => [String(a.id), (a.is_required as number | undefined) !== 0]));
    let childActive = 0;
    let childActiveRequired = 0;
    let childActiveOptional = 0;
    let childCompleted = 0;
    let childFailed = 0;
    let childFailedRequired = 0;
    let childFailedOptional = 0;
    let childCancelRequested = 0;

    for (const c of childRecords) {
      const isReq = assignmentMap.get(c.assignmentId) ?? true;
      if (c.status === "queued" || c.status === "running") {
        childActive += 1;
        if (isReq) childActiveRequired += 1;
        else childActiveOptional += 1;
      } else if (c.status === "completed") {
        childCompleted += 1;
      } else if (c.status === "failed" || c.status === "timed_out") {
        childFailed += 1;
        if (isReq) childFailedRequired += 1;
        else childFailedOptional += 1;
      }

      if (c.cancelRequested && !c.nativeTerminationConfirmed) childCancelRequested += 1;
    }

    // 6. Lifecycle barriers must be represented in the same authoritative state
    // used for verification eligibility and stale-result detection.
    let unresolvedDeferredReplacement = false;
    try {
      const row = this.db.query(
        `SELECT COUNT(*) AS count FROM deferred_replacements
         WHERE old_run_id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown')`,
      ).get(runId) as { count: number } | undefined;
      unresolvedDeferredReplacement = (row?.count ?? 0) > 0;
    } catch {
      // Older pre-V13 databases are not eligible for live verification authority.
      unresolvedDeferredReplacement = true;
    }

    // 7. Progress & Diagnostics
    const progDiag = this.progressService.getDiagnosticsForRun(runId);

    // 8. Phase & Terminal status
    const phase = taskRun.state as OrchestrationPhase;
    const isTerminal = phase === "completed" || phase === "failed" || phase === "cancelled";

    return {
      runId,
      sessionId: resolvedSessionId,
      executionClass,
      phase,
      aggregateVersion: taskRun.aggregateVersion,
      currentWorkItemId: currentWorkItem?.id,
      currentAssignmentId: currentWorkItem?.id,
      currentExecutionId: currentChild?.executionId,
      workItems,
      progress: {
        noProgressCount: progDiag.noProgressCount,
        lastProgressAt: progDiag.lastProgressAt,
        lastProgressReason: progDiag.lastProgressReason,
        stalled: progDiag.isStalled,
        stallReasons: progDiag.stallReason ? progDiag.stallReason.split(", ") : [],
        lastEvidenceDelta: progDiag.lastEvidenceDelta,
        lastRepositoryDelta: progDiag.lastRepositoryDelta,
      },
      childState: {
        active: childActive,
        activeRequired: childActiveRequired,
        activeOptional: childActiveOptional,
        completed: childCompleted,
        failed: childFailed,
        failedRequired: childFailedRequired,
        failedOptional: childFailedOptional,
        cancelRequested: childCancelRequested,
      },
      lifecycleBlocks: {
        cancellationPending: childCancelRequested > 0,
        unresolvedDeferredReplacement,
      },
      verificationState: {
        lastVerificationHash: undefined,
      },
      terminalState: {
        isTerminal,
        status: phase,
      },
    };
  }
}
