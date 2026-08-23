/**
 * ProgressObservationService — Authoritative progress and stall detection service.
 *
 * Normalizes tool activity, child lifecycle events, repository state deltas,
 * assignment state deltas, and verification deltas into the existing
 * AdaptiveExecutionControl (StallObservation) model.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { StallObservation, StallResult } from "../../services/adaptive-execution-control";
import { detectStall } from "../../services/adaptive-execution-control";

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

export interface ProgressDiagnostics {
  lastProgressAt?: string;
  noProgressCount: number;
  lastProgressReason?: string;
  stallReason?: string;
  lastEvidenceDelta: number;
  lastRepositoryDelta: number;
  isStalled: boolean;
}

export class ProgressObservationService {
  private readonly stateByRun = new Map<string, {
    lastActionFingerprint?: string;
    lastResultFingerprint?: string;
    lastRepositoryHash?: string;
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
  }>();

  constructor(private readonly db: Database) {}

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

  /** Observe tool execution completion and calculate evidence/state deltas. */
  recordToolObservation(input: {
    runId: string;
    sessionId: string;
    tool: string;
    args?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
    error?: string;
    repositoryHash?: string;
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

    // 1. Evidence delta check: is the output/error novel?
    let evidenceDelta = 0;
    const outputHash = createHash("sha256").update(input.output || input.error || "").digest("hex").slice(0, 16);
    if (input.output && input.output.trim().length > 0 && !state.seenEvidenceHashes.has(outputHash)) {
      state.seenEvidenceHashes.add(outputHash);
      evidenceDelta = 1;
    }

    // 2. Repository delta check
    let repositoryStateDelta = 0;
    if (input.repositoryHash && input.repositoryHash !== state.lastRepositoryHash) {
      repositoryStateDelta = 1;
      state.lastRepositoryHash = input.repositoryHash;
    }

    // 3. Verification delta check (e.g. test outputs or audit checks)
    let verificationDelta = 0;
    if (input.metadata && (input.metadata.verified === true || typeof input.metadata.passed === "number")) {
      verificationDelta = 1;
    }

    // 4. Repeated action / failure tracking
    const isSameAction = state.lastActionFingerprint === actionFp;
    const isSameResult = state.lastResultFingerprint === resultFp;

    if (input.error) {
      const failSig = `${input.tool}:${input.error}`;
      if (state.seenFailureSignatures.has(failSig)) {
        state.repeatedFailure += 1;
      } else {
        state.seenFailureSignatures.add(failSig);
        // Novel failure evidence is progress on first encounter
        evidenceDelta = Math.max(evidenceDelta, 1);
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

    if (repositoryStateDelta === 0 && (input.tool === "write" || input.tool === "edit" || input.tool === "patch")) {
      state.unchangedDiff += 1;
    } else if (repositoryStateDelta > 0) {
      state.unchangedDiff = 0;
    }

    if (isSameAction && isSameResult && evidenceDelta === 0) {
      state.repeatedContext += 1;
    } else {
      state.repeatedContext = 0;
    }

    const tokens = input.tokensUsed ?? 0;
    state.tokensSinceProgress += tokens;

    // 5. Evaluate genuine progress
    let isProgress = false;
    let progressReason: string | undefined;

    if (repositoryStateDelta > 0) {
      isProgress = true;
      progressReason = "repository_mutation";
    } else if (verificationDelta > 0) {
      isProgress = true;
      progressReason = "verification_state_change";
    } else if (evidenceDelta > 0 && (!isSameAction || !isSameResult)) {
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

    state.lastActionFingerprint = actionFp;
    state.lastResultFingerprint = resultFp;
    state.lastEvidenceDelta = evidenceDelta;
    state.lastRepositoryDelta = repositoryStateDelta;

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

    return {
      runId: input.runId,
      sessionId: input.sessionId,
      assignmentId: input.assignmentId,
      executionId: input.executionId,
      actionFingerprint: actionFp,
      resultFingerprint: resultFp,
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
      isProgress = true;
      progressReason = "child_execution_completed";
      evidenceDelta = 1;
      executionStateDelta = 1;
      assignmentStateDelta = 1;
      state.repeatedFailure = 0;
    } else if (input.newState === "failed") {
      const failSig = `child:${input.executionId}:${input.error ?? "failed"}`;
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
      isProgress = true;
      progressReason = "child_execution_started";
      executionStateDelta = 1;
      assignmentStateDelta = 1;
    }

    if (isProgress) {
      state.tokensSinceProgress = 0;
      state.noProgressCount = 0;
      state.lastProgressAt = now;
      state.lastProgressReason = progressReason;
    } else {
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

    return {
      runId: input.runId,
      sessionId: input.sessionId,
      assignmentId: input.assignmentId,
      executionId: input.executionId,
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
    };
  }

  /** Reset in-memory state (useful in tests or session reset). */
  reset(runId?: string): void {
    if (runId) {
      this.stateByRun.delete(runId);
    } else {
      this.stateByRun.clear();
    }
  }
}
