/**
 * ProgressObservationService — Authoritative progress, evidence quality, and stall detection service.
 *
 * Persists progress observation aggregates in SQLite (execution_metadata table),
 * tracks pre/post tool execution state (content-based repository hashes, verification results),
 * enforces fail-closed durability and schema validation upon recovery,
 * and feeds normalized StallObservation into AdaptiveExecutionControl.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod/v4";
import type { StallObservation, StallResult } from "../../services/adaptive-execution-control";
import { detectStall } from "../../services/adaptive-execution-control";

export type EvidenceKind =
  | "informational"
  | "diagnostic"
  | "implementation"
  | "verification"
  | "blocker"
  | "child_result";

export type VerificationDirection =
  | "improvement"
  | "regression"
  | "neutral_change";

export interface VerificationDelta {
  changed: boolean;
  direction: VerificationDirection;
}

export interface ActionFingerprintInput {
  tool: string;
  args?: Record<string, unknown> | null;
  sessionID: string;
}

export interface ResultFingerprintInput {
  tool: string;
  output?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface ProgressObservation {
  runId: string;
  sessionId: string;
  assignmentId?: string;
  executionId?: string;
  actionFingerprint?: string;
  resultFingerprint?: string;
  evidenceKind: EvidenceKind;
  evidenceDelta: number;
  repositoryStateDelta: number;
  verificationDelta: number;
  assignmentStateDelta: number;
  executionStateDelta: number;
  repeatedFailure: number;
  repeatedTool: number;
  unchangedDiff: number;
  repeatedContext: number;
  tokensSinceProgress: number;
  isProgress: boolean;
  progressReason?: string;
  stallResult?: StallResult;
  timestamp: string;
}

export interface PersistedProgressObservation {
  observation: ProgressObservation;
  persisted: boolean;
}

export interface ProgressDiagnostics {
  lastProgressAt?: string;
  noProgressCount: number;
  lastProgressReason?: string;
  stallReason?: string;
  lastEvidenceDelta: number;
  lastRepositoryDelta: number;
  isStalled: boolean;
  corruptRecovery?: boolean;
}

export const DurableProgressStateSchema = z.object({
  lastActionFingerprint: z.string().optional(),
  lastResultFingerprint: z.string().optional(),
  lastRepositoryHash: z.string().optional(),
  lastVerificationHash: z.string().optional(),
  repeatedFailure: z.number().int().min(0),
  repeatedTool: z.number().int().min(0),
  unchangedDiff: z.number().int().min(0),
  repeatedContext: z.number().int().min(0),
  tokensSinceProgress: z.number().int().min(0),
  noProgressCount: z.number().int().min(0),
  lastProgressAt: z.string().optional(),
  lastProgressReason: z.string().optional(),
  lastStallResult: z.any().optional(),
  lastEvidenceDelta: z.number().int().min(0),
  lastRepositoryDelta: z.number().int().min(0),
  seenFailureSignatures: z.array(z.string()),
  seenEvidenceHashes: z.array(z.string()),
});

export type DurableProgressState = z.infer<typeof DurableProgressStateSchema>;

export class ProgressObservationService {
  private readonly stateByRun = new Map<string, {
    lastActionFingerprint?: string;
    lastResultFingerprint?: string;
    lastRepositoryHash?: string;
    lastVerificationHash?: string;
    repeatedFailure: number;
    repeatedTool: number;
    unchangedDiff: number;
    repeatedContext: number;
    tokensSinceProgress: number;
    noProgressCount: number;
    lastProgressAt?: string;
    lastProgressReason?: string;
    lastStallResult?: StallResult;
    lastEvidenceDelta: number;
    lastRepositoryDelta: number;
    seenFailureSignatures: Set<string>;
    seenEvidenceHashes: Set<string>;
    recoveryError?: boolean;
  }>();

  constructor(private readonly db: Database) {
    this.reconcileAfterRestart();
  }

  /**
   * Persist state for run into execution_metadata table with fail-closed semantics.
   * Throws Error on failure to ensure authoritative failure propagation.
   */
  private persistState(runId: string): void {
    const mem = this.stateByRun.get(runId);
    if (!mem) return;

    const durable: DurableProgressState = {
      lastActionFingerprint: mem.lastActionFingerprint,
      lastResultFingerprint: mem.lastResultFingerprint,
      lastRepositoryHash: mem.lastRepositoryHash,
      lastVerificationHash: mem.lastVerificationHash,
      repeatedFailure: mem.repeatedFailure,
      repeatedTool: mem.repeatedTool,
      unchangedDiff: mem.unchangedDiff,
      repeatedContext: mem.repeatedContext,
      tokensSinceProgress: mem.tokensSinceProgress,
      noProgressCount: mem.noProgressCount,
      lastProgressAt: mem.lastProgressAt,
      lastProgressReason: mem.lastProgressReason,
      lastStallResult: mem.lastStallResult,
      lastEvidenceDelta: mem.lastEvidenceDelta,
      lastRepositoryDelta: mem.lastRepositoryDelta,
      seenFailureSignatures: Array.from(mem.seenFailureSignatures),
      seenEvidenceHashes: Array.from(mem.seenEvidenceHashes),
    };

    // Validate schema before persisting
    DurableProgressStateSchema.parse(durable);

    this.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
    ).run(
      `meta-prog-${runId}`,
      runId,
      `progress_state:${runId}`,
      JSON.stringify(durable)
    );
  }

  /**
   * Reconcile durable progress state after restart with runtime schema validation.
   * Malformed state fails closed rather than silently resetting counters.
   */
  reconcileAfterRestart(runId?: string): void {
    try {
      const rows = runId
        ? this.db.query("SELECT * FROM execution_metadata WHERE run_id = ? AND key LIKE 'progress_state:%'").all(runId)
        : this.db.query("SELECT * FROM execution_metadata WHERE key LIKE 'progress_state:%'").all();

      for (const row of rows as any[]) {
        const rId = row.run_id as string;
        try {
          const raw = JSON.parse(row.value);
          const validated = DurableProgressStateSchema.parse(raw);

          this.stateByRun.set(rId, {
            lastActionFingerprint: validated.lastActionFingerprint,
            lastResultFingerprint: validated.lastResultFingerprint,
            lastRepositoryHash: validated.lastRepositoryHash,
            lastVerificationHash: validated.lastVerificationHash,
            repeatedFailure: validated.repeatedFailure,
            repeatedTool: validated.repeatedTool,
            unchangedDiff: validated.unchangedDiff,
            repeatedContext: validated.repeatedContext,
            tokensSinceProgress: validated.tokensSinceProgress,
            noProgressCount: validated.noProgressCount,
            lastProgressAt: validated.lastProgressAt,
            lastProgressReason: validated.lastProgressReason,
            lastStallResult: validated.lastStallResult,
            lastEvidenceDelta: validated.lastEvidenceDelta,
            lastRepositoryDelta: validated.lastRepositoryDelta,
            seenFailureSignatures: new Set(validated.seenFailureSignatures),
            seenEvidenceHashes: new Set(validated.seenEvidenceHashes),
            recoveryError: false,
          });
        } catch (parseOrValErr) {
          console.error(`[ProgressObservationService] Corrupt/malformed progress state for run ${rId}:`, parseOrValErr);
          // Fail closed: mark as recovery error, retain high noProgressCount to indicate stall/reconciliation needed
          this.stateByRun.set(rId, {
            repeatedFailure: 999,
            repeatedTool: 999,
            unchangedDiff: 999,
            repeatedContext: 999,
            tokensSinceProgress: 999,
            noProgressCount: 999,
            lastEvidenceDelta: 0,
            lastRepositoryDelta: 0,
            seenFailureSignatures: new Set(),
            seenEvidenceHashes: new Set(),
            recoveryError: true,
          });
        }
      }
    } catch (err) {
      console.error("[ProgressObservationService] reconcileAfterRestart error:", err);
    }
  }

  /** Normalize action fingerprint deterministically. */
  computeActionFingerprint(input: ActionFingerprintInput): string {
    const raw = `${input.tool}:${JSON.stringify(input.args ?? {})}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  /** Normalize result fingerprint deterministically. */
  computeResultFingerprint(input: ResultFingerprintInput): string {
    const raw = `${input.tool}:${input.error ?? ""}:${input.output ?? ""}:${JSON.stringify(input.metadata ?? {})}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  /** Classify evidence kind deterministically. */
  classifyEvidenceKind(tool: string, error?: string, repositoryStateDelta: number = 0, isVerification: boolean = false): EvidenceKind {
    if (isVerification) return "verification";
    if (repositoryStateDelta > 0) return "implementation";
    if (error && error.trim().length > 0) return "diagnostic";
    const readTools = new Set(["read", "grep", "list", "glob", "read_file", "search_files", "list_dir"]);
    if (readTools.has(tool)) return "informational";
    return "informational";
  }

  /**
   * Observe tool execution completion and calculate evidence/state deltas.
   * Throws if durable persistence fails (fail-closed).
   */
  recordToolObservation(input: {
    runId: string;
    sessionId: string;
    tool: string;
    args?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
    error?: string;
    preRepositoryHash?: string;
    postRepositoryHash?: string;
    tokensUsed?: number;
    assignmentId?: string;
    executionId?: string;
  }): ProgressObservation {
    const now = new Date().toISOString();
    let state = this.stateByRun.get(input.runId);
    if (!state) {
      state = {
        repeatedFailure: 0,
        repeatedTool: 0,
        unchangedDiff: 0,
        repeatedContext: 0,
        tokensSinceProgress: 0,
        noProgressCount: 0,
        lastEvidenceDelta: 0,
        lastRepositoryDelta: 0,
        seenFailureSignatures: new Set(),
        seenEvidenceHashes: new Set(),
      };
      this.stateByRun.set(input.runId, state);
    }

    const actionFp = this.computeActionFingerprint({
      tool: input.tool,
      args: input.args,
      sessionID: input.sessionId,
    });
    const resultFp = this.computeResultFingerprint({
      tool: input.tool,
      output: input.output,
      metadata: input.metadata,
      error: input.error,
    });

    // 1. Repository delta check: compare pre and post hashes
    let repositoryStateDelta = 0;
    const preHash = input.preRepositoryHash ?? state.lastRepositoryHash;
    const postHash = input.postRepositoryHash;
    if (preHash !== undefined && postHash !== undefined && preHash !== postHash) {
      repositoryStateDelta = 1;
      state.lastRepositoryHash = postHash;
    } else if (postHash !== undefined && state.lastRepositoryHash === undefined) {
      state.lastRepositoryHash = postHash;
      repositoryStateDelta = 0;
    }

    // 2. Evidence delta check: is the output/error novel?
    let evidenceDelta = 0;
    const isMutating = input.tool === "write" || input.tool === "edit" || input.tool === "patch" || input.tool === "apply_patch";
    const outputHash = createHash("sha256").update(input.output || input.error || "").digest("hex").slice(0, 16);
    // Mutating tools with unchanged diff do NOT count output text as novel evidence
    if (!isMutating || repositoryStateDelta > 0) {
      if ((input.output && input.output.trim().length > 0) || (input.error && input.error.trim().length > 0)) {
        if (!state.seenEvidenceHashes.has(outputHash)) {
          state.seenEvidenceHashes.add(outputHash);
          evidenceDelta = 1;
        }
      }
    }

    // 3. Verification delta check (opportunistic tool metadata)
    let verificationDelta = 0;
    if (input.metadata && (typeof input.metadata.passed === "number" || typeof input.metadata.failed === "number" || input.metadata.verified !== undefined)) {
      const verKey = `${input.metadata.passed ?? 0}:${input.metadata.failed ?? 0}:${input.metadata.verified ?? ""}:${input.metadata.exitCode ?? 0}`;
      if (state.lastVerificationHash !== undefined && state.lastVerificationHash !== verKey) {
        verificationDelta = 1;
      }
      state.lastVerificationHash = verKey;
    }

    // 4. Repeated action / failure tracking
    const isSameAction = state.lastActionFingerprint === actionFp;
    const isSameResult = state.lastResultFingerprint === resultFp;

    let isNovelDiagnostic = false;
    if (input.error) {
      const failSig = `${input.tool}:${input.error}`;
      if (state.seenFailureSignatures.has(failSig)) {
        state.repeatedFailure += 1;
      } else {
        state.seenFailureSignatures.add(failSig);
        evidenceDelta = Math.max(evidenceDelta, 1);
        isNovelDiagnostic = true;
        state.repeatedFailure = 0;
      }
    } else {
      state.repeatedFailure = 0;
    }

    if (isSameAction) {
      state.repeatedTool += 1;
    } else {
      state.repeatedTool = 0;
    }

    if (repositoryStateDelta === 0 && (input.tool === "write" || input.tool === "edit" || input.tool === "patch" || input.tool === "apply_patch")) {
      state.unchangedDiff += 1;
    } else if (repositoryStateDelta > 0) {
      state.unchangedDiff = 0;
    }

    if (isSameAction && isSameResult && evidenceDelta === 0) {
      state.repeatedContext += 1;
    } else {
      state.repeatedContext = 0;
    }

    const tokens = typeof input.tokensUsed === "number" && Number.isFinite(input.tokensUsed) ? input.tokensUsed : 0;
    state.tokensSinceProgress += tokens;

    state.lastActionFingerprint = actionFp;
    state.lastResultFingerprint = resultFp;
    state.lastEvidenceDelta = evidenceDelta;
    state.lastRepositoryDelta = repositoryStateDelta;

    const evidenceKind = this.classifyEvidenceKind(input.tool, input.error, repositoryStateDelta, verificationDelta > 0);

    // Progress evaluation policy:
    // - implementation mutation -> positive progress
    // - verification state change -> positive progress
    // - novel diagnostic evidence -> positive progress once
    // - informational reads -> evidence recorded, but does NOT indefinitely reset noProgressCount
    let isProgress = false;
    let progressReason: string | undefined;

    if (repositoryStateDelta > 0) {
      isProgress = true;
      progressReason = "repository_mutation";
    } else if (verificationDelta > 0) {
      isProgress = true;
      progressReason = "verification_state_change";
    } else if (isNovelDiagnostic) {
      isProgress = true;
      progressReason = "novel_diagnostic_acquired";
    } else if (evidenceKind === "informational" && evidenceDelta > 0) {
      // Legacy compatibility: initial novel evidence discovery
      isProgress = true;
      progressReason = "novel_evidence_acquired";
    }

    if (isProgress) {
      state.tokensSinceProgress = 0;
      state.noProgressCount = 0;
      state.lastProgressAt = now;
      state.lastProgressReason = progressReason;
    } else {
      state.noProgressCount += 1;
    }

    const stallObservation: StallObservation = {
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      evidenceDelta,
      tokensSinceProgress: state.tokensSinceProgress,
    };

    const stallResult = detectStall(stallObservation);
    state.lastStallResult = stallResult;

    // Fail-closed persistence: throws on failure
    this.persistState(input.runId);

    return {
      runId: input.runId,
      sessionId: input.sessionId,
      assignmentId: input.assignmentId,
      executionId: input.executionId,
      actionFingerprint: actionFp,
      resultFingerprint: resultFp,
      evidenceKind,
      evidenceDelta,
      repositoryStateDelta,
      verificationDelta,
      assignmentStateDelta: 0,
      executionStateDelta: 0,
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      tokensSinceProgress: state.tokensSinceProgress,
      isProgress,
      progressReason,
      stallResult,
      timestamp: now,
    };
  }

  /**
   * Observe canonical verification state from VerificationService.
   * Distinguishes improvement, regression, and neutral change.
   * Only improvement counts as positive progress.
   */
  recordVerificationObservation(input: {
    runId: string;
    sessionId?: string;
    assignmentId?: string;
    executionId?: string;
    verificationId: string;
    status: string;
    passed?: number;
    failed?: number;
    evidenceIds?: string[];
    fingerprint: string;
  }): ProgressObservation {
    const now = new Date().toISOString();
    let state = this.stateByRun.get(input.runId);
    if (!state) {
      state = {
        repeatedFailure: 0,
        repeatedTool: 0,
        unchangedDiff: 0,
        repeatedContext: 0,
        tokensSinceProgress: 0,
        noProgressCount: 0,
        lastEvidenceDelta: 0,
        lastRepositoryDelta: 0,
        seenFailureSignatures: new Set(),
        seenEvidenceHashes: new Set(),
      };
      this.stateByRun.set(input.runId, state);
    }

    let verificationDelta = 0;
    let _direction: VerificationDirection = "neutral_change";
    let isProgress = false;
    let progressReason: string | undefined;

    if (state.lastVerificationHash !== undefined && state.lastVerificationHash !== input.fingerprint) {
      verificationDelta = 1;

      // Extract passed/failed counts to determine direction if present
      const prevParts = state.lastVerificationHash.split(":");
      const currParts = input.fingerprint.split(":");
      const prevFailed = parseInt(prevParts[1] ?? "0", 10);
      const currFailed = parseInt(currParts[1] ?? "0", 10);
      const prevPassed = parseInt(prevParts[0] ?? "0", 10);
      const currPassed = parseInt(currParts[0] ?? "0", 10);

      if (currFailed < prevFailed || (currFailed === prevFailed && currPassed > prevPassed) || input.status === "passed") {
        _direction = "improvement";
        isProgress = true;
        progressReason = "verification_improvement";
      } else if (currFailed > prevFailed || input.status === "failed") {
        _direction = "regression";
        isProgress = false;
        progressReason = "verification_regression";
      } else {
        _direction = "neutral_change";
        isProgress = false;
      }
    } else if (state.lastVerificationHash === undefined) {
      // First baseline
      state.lastVerificationHash = input.fingerprint;
      verificationDelta = 0;
      if (input.status === "passed") {
        isProgress = true;
        progressReason = "verification_baseline_passed";
      }
    }

    state.lastVerificationHash = input.fingerprint;

    if (isProgress) {
      state.tokensSinceProgress = 0;
      state.noProgressCount = 0;
      state.lastProgressAt = now;
      state.lastProgressReason = progressReason;
    } else {
      state.noProgressCount += 1;
    }

    const stallObservation: StallObservation = {
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      evidenceDelta: 0,
      tokensSinceProgress: state.tokensSinceProgress,
    };
    const stallResult = detectStall(stallObservation);
    state.lastStallResult = stallResult;

    this.persistState(input.runId);

    return {
      runId: input.runId,
      sessionId: input.sessionId ?? "",
      assignmentId: input.assignmentId,
      executionId: input.executionId,
      evidenceKind: "verification",
      evidenceDelta: 0,
      repositoryStateDelta: 0,
      verificationDelta,
      assignmentStateDelta: 0,
      executionStateDelta: 0,
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      tokensSinceProgress: state.tokensSinceProgress,
      isProgress,
      progressReason,
      stallResult,
      timestamp: now,
    };
  }

  /** Observe child lifecycle transitions (queued -> running, completed, failed, cancelled). */
  recordChildLifecycleObservation(input: {
    runId: string;
    sessionId: string;
    assignmentId: string;
    executionId: string;
    previousState?: string;
    newState: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
    result?: string;
    error?: string;
  }): ProgressObservation {
    const now = new Date().toISOString();
    let state = this.stateByRun.get(input.runId);
    if (!state) {
      state = {
        repeatedFailure: 0,
        repeatedTool: 0,
        unchangedDiff: 0,
        repeatedContext: 0,
        tokensSinceProgress: 0,
        noProgressCount: 0,
        lastEvidenceDelta: 0,
        lastRepositoryDelta: 0,
        seenFailureSignatures: new Set(),
        seenEvidenceHashes: new Set(),
      };
      this.stateByRun.set(input.runId, state);
    }

    let isProgress = false;
    let progressReason: string | undefined;
    let evidenceDelta = 0;
    let executionStateDelta = 0;
    let assignmentStateDelta = 0;

    if (input.newState === "completed") {
      const compSig = `child_comp:${input.executionId}:${input.result ?? ""}`;
      if (!state.seenEvidenceHashes.has(compSig)) {
        state.seenEvidenceHashes.add(compSig);
        isProgress = true;
        progressReason = "child_execution_completed";
        evidenceDelta = 1;
        executionStateDelta = 1;
        assignmentStateDelta = 1;
        state.repeatedFailure = 0;
      } else {
        isProgress = false;
        evidenceDelta = 0;
      }
    } else if (input.newState === "failed") {
      const failSig = `child_fail:${input.executionId}:${input.error ?? "failed"}`;
      if (state.seenFailureSignatures.has(failSig)) {
        state.repeatedFailure += 1;
        isProgress = false;
      } else {
        state.seenFailureSignatures.add(failSig);
        isProgress = true;
        progressReason = "child_failure_evidence_acquired";
        evidenceDelta = 1;
        executionStateDelta = 1;
        state.repeatedFailure = 0;
      }
    } else if (input.newState === "running" && input.previousState === "queued") {
      // Child start records state delta, but does NOT reset noProgressCount to prevent launch spam
      executionStateDelta = 1;
      assignmentStateDelta = 1;
      isProgress = false;
      progressReason = "child_execution_started";
    } else if (input.newState === "cancelled") {
      executionStateDelta = 1;
      assignmentStateDelta = 1;
      isProgress = false;
    }

    if (isProgress) {
      state.tokensSinceProgress = 0;
      state.noProgressCount = 0;
      state.lastProgressAt = now;
      state.lastProgressReason = progressReason;
    } else if (input.newState !== "cancelled" && input.newState !== "running") {
      state.noProgressCount += 1;
    }

    state.lastEvidenceDelta = evidenceDelta;

    const stallObservation: StallObservation = {
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      evidenceDelta,
      tokensSinceProgress: state.tokensSinceProgress,
    };

    const stallResult = detectStall(stallObservation);
    state.lastStallResult = stallResult;

    // Fail closed: persist durably
    this.persistState(input.runId);

    return {
      runId: input.runId,
      sessionId: input.sessionId,
      assignmentId: input.assignmentId,
      executionId: input.executionId,
      evidenceKind: "child_result",
      evidenceDelta,
      repositoryStateDelta: 0,
      verificationDelta: 0,
      assignmentStateDelta,
      executionStateDelta,
      repeatedFailure: state.repeatedFailure,
      repeatedTool: state.repeatedTool,
      unchangedDiff: state.unchangedDiff,
      repeatedContext: state.repeatedContext,
      tokensSinceProgress: state.tokensSinceProgress,
      isProgress,
      progressReason,
      stallResult,
      timestamp: now,
    };
  }

  /** Get diagnostics for a run. */
  getDiagnosticsForRun(runId: string): ProgressDiagnostics {
    const state = this.stateByRun.get(runId);
    if (!state) {
      return {
        noProgressCount: 0,
        lastEvidenceDelta: 0,
        lastRepositoryDelta: 0,
        isStalled: false,
      };
    }

    return {
      lastProgressAt: state.lastProgressAt,
      noProgressCount: state.noProgressCount,
      lastProgressReason: state.lastProgressReason,
      stallReason: state.lastStallResult?.reasons?.join(", "),
      lastEvidenceDelta: state.lastEvidenceDelta,
      lastRepositoryDelta: state.lastRepositoryDelta,
      isStalled: state.lastStallResult?.stalled === true,
      corruptRecovery: state.recoveryError === true,
    };
  }

  /** Reset in-memory and durable state (useful in tests or session reset). */
  reset(runId?: string): void {
    if (runId) {
      this.stateByRun.delete(runId);
      try {
        this.db.query("DELETE FROM execution_metadata WHERE run_id = ? AND key = ?").run(runId, `progress_state:${runId}`);
      } catch {}
    } else {
      this.stateByRun.clear();
      try {
        this.db.query("DELETE FROM execution_metadata WHERE key LIKE 'progress_state:%'").run();
      } catch {}
    }
  }
}
