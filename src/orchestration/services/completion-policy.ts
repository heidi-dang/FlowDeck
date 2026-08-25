import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../persistence/transaction-manager";
import { OrchestrationPhase as OP } from "../types/runs";
import type { OrchestrationSnapshot, OrchestrationSnapshotService } from "./orchestration-snapshot-service";
import type { RunTransitionEngine } from "./transition-engine";

const POLICY_VERSION = "completion-policy-v1";
const LIVE_CHECK_TYPE = "live_orchestration";
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const FINGERPRINT_PATTERN = /^[a-f0-9]{32}$/i;
const VERIFICATION_STATUSES = new Set(["pending", "in_progress", "passed", "failed", "skipped", "error"]);

type CompletionPolicyStatus = "COMPLETED" | "ALREADY_COMPLETED" | "BLOCKED" | "CONFLICT";

export interface CompletionPolicyResult {
  status: CompletionPolicyStatus;
  runId: string;
  completionKey?: string;
  reviewId?: string;
  blockerReasons: string[];
}

export interface EvaluateCompletionPolicyInput {
  runId: string;
  sessionId?: string;
  /** The durable verification row whose passed state is necessary but never sufficient on its own. */
  verificationId: string;
}

interface LiveVerificationAuthorityRow {
  id: string;
  runId: string;
  checkType: string;
  status: string;
  stateVersion: number;
  stateFingerprint: string;
  targetSha: string;
  isStale: boolean;
  evidenceIds: string[];
  failureReasons: string[];
}

/**
 * Sole completion authority for a live orchestration Run.
 *
 * The policy recomputes all authority from SQLite inside a write transaction.
 * It never trusts session-idle, worker prose, or an in-memory token as evidence
 * of completion.  The V10 review row (extended by V15) is both the durable
 * idempotency record and the audit trail linking a successful CAS to the exact
 * verification result and snapshot fingerprint that justified it.
 */
export class CompletionPolicy {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
    private readonly snapshotService: OrchestrationSnapshotService,
    private readonly transitionEngine: RunTransitionEngine,
  ) {}

  evaluateAndComplete(input: EvaluateCompletionPolicyInput): CompletionPolicyResult {
    return this.tx.writeImmediate(() => this.evaluateInTransaction(input));
  }

  private evaluateInTransaction(input: EvaluateCompletionPolicyInput): CompletionPolicyResult {
    const snapshot = this.snapshotService.getSnapshot(input.runId, input.sessionId);
    if (!snapshot) {
      return this.blocked(input.runId, ["RUN_NOT_FOUND"]);
    }

    if (snapshot.phase === OP.COMPLETED) {
      const existing = this.db.query(
        "SELECT id, completion_key, decision_json FROM heidi_completion_reviews WHERE task_run_id = ? AND status = 'completed' ORDER BY completed_at DESC, created_at DESC LIMIT 1",
      ).get(input.runId) as Record<string, unknown> | undefined;
      if (!existing || !this.isValidDecisionJson(existing.decision_json)) {
        return this.blocked(input.runId, ["COMPLETED_WITHOUT_VALID_POLICY_REVIEW"]);
      }
      return {
        status: "ALREADY_COMPLETED",
        runId: input.runId,
        completionKey: String(existing.completion_key),
        reviewId: String(existing.id),
        blockerReasons: [],
      };
    }

    const blockers = this.collectSnapshotBlockers(snapshot);
    const fingerprint = this.snapshotService.computeStateFingerprint(input.runId, input.sessionId);
    if (!fingerprint || !FINGERPRINT_PATTERN.test(fingerprint)) blockers.push("STATE_FINGERPRINT_UNAVAILABLE");

    const verification = this.loadAndValidateLiveVerification(input.verificationId, input.runId);
    if (verification.blockers.length > 0) blockers.push(...verification.blockers);

    if (verification.value && fingerprint) {
      if (verification.value.stateVersion !== snapshot.aggregateVersion) blockers.push("VERIFICATION_STATE_VERSION_STALE");
      if (verification.value.stateFingerprint !== fingerprint) blockers.push("VERIFICATION_STATE_FINGERPRINT_STALE");
    }

    if (blockers.length > 0 || !verification.value || !fingerprint) {
      return this.blocked(input.runId, blockers);
    }

    const completionKey = this.completionKey(input.runId, snapshot.aggregateVersion, fingerprint, verification.value.id);
    const reviewId = `completion-review-${this.digest(completionKey)}`;
    const decision = {
      policyVersion: POLICY_VERSION,
      runId: input.runId,
      stateVersion: snapshot.aggregateVersion,
      stateFingerprint: fingerprint,
      verificationId: verification.value.id,
      verificationTargetSha: verification.value.targetSha,
      evidenceIds: verification.value.evidenceIds,
      decidedPhase: OP.COMPLETED,
    };
    const decisionJson = JSON.stringify(decision);

    const existing = this.db.query(
      "SELECT id, status, completion_key, decision_json FROM heidi_completion_reviews WHERE completion_key = ?",
    ).get(completionKey) as Record<string, unknown> | undefined;
    if (existing?.status === "completed") {
      if (!this.isValidDecisionJson(existing.decision_json)) {
        return this.blocked(input.runId, ["COMPLETION_REVIEW_CORRUPT"]);
      }
      return { status: "ALREADY_COMPLETED", runId: input.runId, completionKey, reviewId: String(existing.id), blockerReasons: [] };
    }
    if (existing && existing.status !== "running") {
      return this.blocked(input.runId, ["COMPLETION_REVIEW_TERMINAL_WITHOUT_COMPLETION"]);
    }

    if (!existing) {
      this.db.query(
        `INSERT INTO heidi_completion_reviews (
          id, completion_key, session_id, task_run_id, status, created_at,
          state_version, state_fingerprint, verification_id, decision_json, policy_version
        ) VALUES (?, ?, ?, ?, 'running', datetime('now'), ?, ?, ?, ?, ?)`,
      ).run(
        reviewId,
        completionKey,
        input.sessionId ?? null,
        input.runId,
        snapshot.aggregateVersion,
        fingerprint,
        verification.value.id,
        decisionJson,
        POLICY_VERSION,
      );
    }

    // This guarded call is the only code path that passes completion_policy
    // authority to RunTransitionEngine.  The engine in turn performs the
    // mandatory phase/version CAS against task_runs.
    const transitioned = this.transitionEngine.transitionPhase({
      runId: input.runId,
      targetPhase: OP.COMPLETED,
      expectedPhase: OP.VERIFYING,
      expectedAggregateVersion: snapshot.aggregateVersion,
      completionPolicy: this,
      sha: verification.value.targetSha,
    });
    if (!transitioned) {
      this.db.query(
        "UPDATE heidi_completion_reviews SET status = 'failed', error = ?, completed_at = datetime('now') WHERE completion_key = ? AND status = 'running'",
      ).run("COMPLETION_CAS_CONFLICT", completionKey);
      return { status: "CONFLICT", runId: input.runId, completionKey, reviewId, blockerReasons: ["COMPLETION_CAS_CONFLICT"] };
    }

    const eventId = `completion-event-${this.digest(completionKey)}`;
    this.db.query(
      "UPDATE task_runs SET completed_at = datetime('now') WHERE run_id = ? AND state = ? AND aggregate_version = ?",
    ).run(input.runId, OP.COMPLETED, snapshot.aggregateVersion + 1);
    this.db.query(
      "UPDATE heidi_completion_reviews SET status = 'completed', candidate_id = ?, error = NULL, completed_at = datetime('now'), decision_json = ? WHERE completion_key = ? AND status = 'running'",
    ).run(eventId, decisionJson, completionKey);
    this.db.query(
      "INSERT OR IGNORE INTO completion_decisions (id, run_id, decision, sha, checks, idempotency_key, decided_at) VALUES (?, ?, 'pass', ?, ?, ?, datetime('now'))",
    ).run(eventId, input.runId, verification.value.targetSha, decisionJson, completionKey);
    this.db.query(
      `INSERT OR IGNORE INTO events (
        event_id, event_type, event_version, causation_id, correlation_id,
        aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts
      ) VALUES (?, 'run.completed', 1, ?, ?, 'task_run', ?, ?, datetime('now'), ?, '{}', strftime('%s','now'))`,
    ).run(eventId, verification.value.id, input.runId, input.runId, snapshot.aggregateVersion + 1, decisionJson);
    this.db.query(
      `INSERT OR IGNORE INTO event_outbox (
        id, event_id, event_type, aggregate_id, data, status, retry_count,
        idempotency_key, source_component, created_ts
      ) VALUES (?, ?, 'run.completed', ?, ?, 'pending', 0, ?, 'completion_policy', strftime('%s','now'))`,
    ).run(`outbox-${this.digest(completionKey)}`, eventId, input.runId, decisionJson, completionKey);

    return { status: "COMPLETED", runId: input.runId, completionKey, reviewId, blockerReasons: [] };
  }

  private collectSnapshotBlockers(snapshot: OrchestrationSnapshot): string[] {
    const blockers: string[] = [];
    if (snapshot.phase !== OP.VERIFYING) blockers.push("RUN_NOT_VERIFYING");
    if (snapshot.terminalState?.isTerminal) blockers.push("RUN_TERMINAL");

    const required = snapshot.workItems.filter(item => item.isRequired);
    if (required.length === 0) blockers.push("NO_REQUIRED_WORK");
    if (required.some(item => !item.isSatisfied)) blockers.push("REQUIRED_WORK_INCOMPLETE");
    if (snapshot.childState.activeRequired > 0) blockers.push("REQUIRED_CHILD_ACTIVE");
    if (snapshot.childState.failedRequired > 0) blockers.push("REQUIRED_CHILD_FAILED");
    if (snapshot.childState.cancelRequested > 0 || snapshot.lifecycleBlocks.cancellationPending) blockers.push("CANCELLATION_BARRIER_UNRESOLVED");
    if (snapshot.lifecycleBlocks.unresolvedDeferredReplacement) blockers.push("DEFERRED_REPLACEMENT_UNRESOLVED");
    if (snapshot.progress.stalled) blockers.push("RECOVERY_REQUIRED");
    return blockers;
  }

  private loadAndValidateLiveVerification(verificationId: string, runId: string): { value?: LiveVerificationAuthorityRow; blockers: string[] } {
    const row = this.db.query("SELECT * FROM verification_results WHERE id = ?").get(verificationId) as Record<string, unknown> | undefined;
    if (!row) return { blockers: ["LIVE_VERIFICATION_MISSING"] };

    const blockers: string[] = [];
    const status = row.status;
    const checkType = row.verification_type;
    const stateVersion = row.state_version;
    const stateFingerprint = row.state_fingerprint;
    const targetSha = row.target_sha;
    const isStale = row.is_stale;
    const evidence = this.parseRequiredStringArray(row.evidence_json, "EVIDENCE_JSON", blockers);
    const failures = this.parseRequiredStringArray(row.failure_reasons, "FAILURE_REASONS", blockers);

    if (row.run_id !== runId) blockers.push("LIVE_VERIFICATION_WRONG_RUN");
    if (checkType !== LIVE_CHECK_TYPE) blockers.push("LIVE_VERIFICATION_WRONG_TYPE");
    if (typeof status !== "string" || !VERIFICATION_STATUSES.has(status)) blockers.push("LIVE_VERIFICATION_STATUS_CORRUPT");
    else if (status !== "passed") blockers.push("LIVE_VERIFICATION_NOT_PASSED");
    if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1) blockers.push("LIVE_VERIFICATION_STATE_VERSION_CORRUPT");
    if (typeof stateFingerprint !== "string" || !FINGERPRINT_PATTERN.test(stateFingerprint)) blockers.push("LIVE_VERIFICATION_FINGERPRINT_CORRUPT");
    if (typeof targetSha !== "string" || !SHA_PATTERN.test(targetSha) || /^0{40}$/i.test(targetSha)) blockers.push("LIVE_VERIFICATION_TARGET_SHA_CORRUPT");
    if (isStale !== 0 && isStale !== 1) blockers.push("LIVE_VERIFICATION_STALE_FLAG_CORRUPT");
    else if (isStale === 1) blockers.push("LIVE_VERIFICATION_STALE");
    if (evidence.length === 0) blockers.push("LIVE_VERIFICATION_NO_EVIDENCE");
    if (failures.length > 0) blockers.push("LIVE_VERIFICATION_FAILURE_REASONS_PRESENT");

    if (blockers.length > 0) return { blockers };
    return {
      value: {
        id: String(row.id),
        runId: String(row.run_id),
        checkType: String(checkType),
        status: String(status),
        stateVersion: stateVersion as number,
        stateFingerprint: String(stateFingerprint),
        targetSha: String(targetSha),
        isStale: isStale === 1,
        evidenceIds: evidence,
        failureReasons: failures,
      },
      blockers,
    };
  }

  private parseRequiredStringArray(value: unknown, field: string, blockers: string[]): string[] {
    if (typeof value !== "string") {
      blockers.push(`LIVE_VERIFICATION_${field}_CORRUPT`);
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || item.length === 0)) {
        blockers.push(`LIVE_VERIFICATION_${field}_CORRUPT`);
        return [];
      }
      return [...new Set(parsed)].sort();
    } catch {
      blockers.push(`LIVE_VERIFICATION_${field}_CORRUPT`);
      return [];
    }
  }

  private completionKey(runId: string, stateVersion: number, stateFingerprint: string, verificationId: string): string {
    return `completion-policy:${runId}:${stateVersion}:${stateFingerprint}:${verificationId}:${POLICY_VERSION}`;
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private isValidDecisionJson(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed !== null && typeof parsed === "object" && parsed.policyVersion === POLICY_VERSION;
    } catch {
      return false;
    }
  }

  private blocked(runId: string, reasons: string[]): CompletionPolicyResult {
    return { status: "BLOCKED", runId, blockerReasons: [...new Set(reasons)].sort() };
  }
}
