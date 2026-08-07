/**
 * Canonical evidence import adapter — transactional, idempotent importer.
 *
 * The ONLY sanctioned path for importing Better Harness evidence into the
 * canonical orchestration evidence store. It loads the authoritative
 * canonical run through the injected CanonicalRunReader (never trusting a
 * caller-provided run id), requires an exact SHA match against the run's
 * current SHA and the report's sourceRevision, rejects ineligible and
 * superseded runs, validates every criterion binding, and persists evidence
 * + lifecycle + linkage + idempotency + batch event/outbox through ONE
 * canonical SQLite transaction boundary.
 *
 * Concurrency / retry model:
 *  - Every source evidence item gets one deterministic idempotency key
 *    (importIdempotencyKey) and one deterministic canonical evidence id
 *    (evidenceIdFromImportKey), so retries map to the same row.
 *  - The idempotency reservation is the transaction boundary: INSERT OR
 *    IGNORE into command_idempotency with the scoped key
 *    `${IMPORT_COMMAND_TYPE}:${runId}:${importKey}` happens INSIDE the
 *    transaction. Completed → replay the previous result; executing → the
 *    import is in progress elsewhere (error); acquired → proceed.
 *  - Any throw inside the transaction rolls back every write (evidence,
 *    lifecycle, linkage, idempotency, event, outbox).
 *
 * This adapter NEVER writes task-run state or completion decisions directly,
 * and never uses harness run ids as canonical run ids.
 *
 * NOTE ON THE TRANSACTION BOUNDARY: SqliteUnitOfWork callbacks must be
 * synchronous (thenables are rejected by assertSync inside the transaction),
 * so all persistence here is done with direct synchronous `db.query` calls
 * inside `tx.write`. The injected EvidenceRepository is used for reads
 * (superseded-report detection); the injected IdempotencyRepository supplies
 * the scoped-key format. SqliteEvidenceRepository remains the read/test
 * surface.
 */

import type { Database } from "bun:sqlite";
import { SqliteUnitOfWork } from "../../orchestration/persistence/unit-of-work";
import type { TransactionManager } from "../../orchestration/persistence/transaction-manager";
import type { CanonicalRun, CanonicalRunReader } from "../../orchestration/evidence/ports/canonical-run-reader";
import type { EvidenceRepository } from "../../orchestration/evidence/ports/evidence-repository";
import { Evidence } from "../../orchestration/evidence/domain/evidence";
import type { IdempotencyRepository } from "../../orchestration/idempotency/ports/idempotency-repository";
import { IdempotencyRecord } from "../../orchestration/idempotency/domain/idempotency-record";
import type { Clock } from "../../orchestration/common/ports/clock";
import type { IdGenerator } from "../../orchestration/common/ports/id-generator";
import { toInstant } from "../../orchestration/common/types";
import type { HarnessReport, HarnessFinding, HarnessEvidence } from "../contracts/report";
import {
  canonicalJson,
  evidenceContentHash,
  evidenceIdFromImportKey,
  importEventId,
  importIdempotencyKey,
  reportFingerprint,
} from "./import-identity";
import {
  CanonicalRunNotFoundError,
  CriterionContractMismatchError,
  CriterionRunMismatchError,
  ImportConflictError,
  ImportFailedError,
  ImportIdempotencyMissingResultError,
  ImportInProgressError,
  ReportShaMismatchError,
  ReportSourceRevisionMissingError,
  ReportSupersededError,
  RunCurrentShaMissingError,
  RunNotEligibleError,
  RunShaMismatchError,
} from "./import-errors";
import type { CanonicalImportError } from "./import-errors";

export const IMPORT_COMMAND_TYPE = "better_harness_evidence_import";

/** Runs that may receive evidence. Terminal states are permanently ineligible. */
const ELIGIBLE_STATES: readonly string[] = [
  "created",
  "planning",
  "analysing",
  "delegating",
  "executing",
  "verifying",
  "recovering",
];

const PROVENANCE_VERSION = 1;
const EVIDENCE_SOURCE = "better-harness";
const EVIDENCE_FORMAT = "better-harness/v1";
const CONTENT_TYPE_PREFIX = "better-harness/";
const FINGERPRINT_PREFIX = "fpx:";

export interface CanonicalEvidenceImportInput {
  /** The canonical run this evidence belongs to (NOT a harness run_ id). */
  readonly runId: string;
  /** The exact source revision (SHA) the evidence was collected against. */
  readonly sha?: string;
  /** The Better Harness report whose findings' evidence will be imported. */
  readonly report: HarnessReport;
  /** Optional criterion IDs (acceptance_criteria ids) to bind evidence to. */
  readonly criterionIds?: readonly string[];
  /** The harness run that produced the report (never stored as run id). */
  readonly harnessRunId?: string;
}

export interface CanonicalEvidenceImportSummary {
  readonly runId: string;
  readonly sha: string;
  readonly importedEvidenceCount: number;
  readonly importedFindingCount: number;
  readonly contentType: string;
  /** True when every item was replayed from a completed idempotency record. */
  readonly replayed: boolean;
  /** Canonical evidence ids for every item (imported or replayed). */
  readonly evidenceIds: readonly string[];
}

/**
 * Immutable provenance persisted on the evidence row's description column as
 * canonical JSON. All 13 fields are required.
 */
export interface EvidenceProvenance {
  readonly canonicalRunId: string;
  readonly targetSha: string;
  readonly harnessRunId: string | null;
  readonly reportFingerprint: string;
  readonly reportGeneratedAt: string;
  readonly harnessFindingId: string;
  readonly harnessEvidenceId: string;
  readonly sourceEvidenceFingerprint: string;
  readonly sourceCategory: string;
  readonly sourceCollectedAt: string;
  readonly contentHash: string;
  readonly importIdempotencyKey: string;
  readonly importedAt: string;
  readonly provenanceVersion: number;
}

/**
 * Test-only fault-injection seam. All hooks default to no-ops, so the
 * production path is unchanged; tests inject throwing hooks to prove the
 * transaction rolls back when a specific persistence step fails.
 */
export interface CanonicalEvidencePersistenceHooks {
  readonly beforeEvidenceWrite?: (evidence: Evidence) => void;
  readonly beforeLifecycleWrite?: (evidence: Evidence) => void;
  readonly beforeLinkWrite?: (evidence: Evidence, criterionId: string) => void;
  readonly beforeEventAppend?: (eventId: string) => void;
}

export interface CanonicalEvidenceImportAdapterDeps {
  readonly db: Database;
  readonly runReader: CanonicalRunReader;
  readonly evidenceRepository: EvidenceRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly persistenceHooks?: CanonicalEvidencePersistenceHooks;
}

interface ImportItem {
  readonly importKey: string;
  readonly evidenceId: string;
  readonly finding: HarnessFinding;
  readonly evidence: HarnessEvidence;
  readonly contentHash: string;
}

interface IdempotencyRow {
  idempotency_key: string;
  command_type: string;
  aggregate_type: string;
  aggregate_id: string;
  status: string;
  owner: string | null;
  started_at: string;
  completed_at: string | null;
  event_id: string | null;
  completion_decision_id: string | null;
  error: string | null;
  created_ts: number;
}

interface PersistencePlan {
  readonly run: CanonicalRun;
  readonly targetSha: string;
  readonly reportFingerprint: string;
  readonly harnessRunId: string | null;
  readonly report: HarnessReport;
  readonly criterionIds: readonly string[];
  readonly items: readonly ImportItem[];
  readonly importedAt: Date;
}

const NOOP_HOOKS: Required<CanonicalEvidencePersistenceHooks> = {
  beforeEvidenceWrite: () => {},
  beforeLifecycleWrite: () => {},
  beforeLinkWrite: () => {},
  beforeEventAppend: () => {},
};

export class CanonicalEvidenceImportAdapter {
  private readonly db: Database;
  private readonly runReader: CanonicalRunReader;
  private readonly evidenceRepository: EvidenceRepository;
  private readonly idempotencyRepository: IdempotencyRepository;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly hooks: Required<CanonicalEvidencePersistenceHooks>;

  constructor(deps: CanonicalEvidenceImportAdapterDeps) {
    this.db = deps.db;
    this.runReader = deps.runReader;
    this.evidenceRepository = deps.evidenceRepository;
    this.idempotencyRepository = deps.idempotencyRepository;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
    this.hooks = { ...NOOP_HOOKS, ...deps.persistenceHooks };
  }

  /**
   * Import all evidence from a Better Harness report into the canonical
   * evidence store, bound to the exact canonical run + SHA.
   *
   * @throws CanonicalImportError (typed reason codes) for every rejection
   *   path; ImportFailedError wraps unexpected persistence failures after
   *   the whole transaction has been rolled back.
   */
  async importReport(input: CanonicalEvidenceImportInput): Promise<CanonicalEvidenceImportSummary> {
    // 1. Resolve and validate the target SHA (report sourceRevision wins the
    //    comparison; caller sha must agree when both are present).
    const targetSha = input.sha ?? input.report.sourceRevision;
    if (!targetSha) {
      throw new ReportSourceRevisionMissingError();
    }
    if (input.report.sourceRevision && input.sha && input.report.sourceRevision !== input.sha) {
      throw new ReportShaMismatchError(input.report.sourceRevision, input.sha);
    }

    // 2. Load the AUTHORITATIVE canonical run. A caller-provided run id is
    //    never sufficient proof of existence — the reader returns undefined
    //    for unknown runs and arbitrary run-like strings alike.
    const run = await this.runReader.getRunById(input.runId);
    if (!run) {
      throw new CanonicalRunNotFoundError(input.runId);
    }

    // 3. The canonical run must have a current SHA (RUN_CURRENT_SHA_MISSING).
    if (!run.currentSha || run.currentSha.length === 0) {
      throw new RunCurrentShaMissingError(input.runId);
    }

    // 4. Exact SHA binding: canonical current SHA === requested import SHA
    //    (RUN_SHA_MISMATCH).
    if (run.currentSha !== targetSha) {
      throw new RunShaMismatchError(input.runId, run.currentSha, targetSha);
    }

    // 5. Reject superseded reports: a newer report (later generatedAt) with
    //    a different fingerprint already imported for this run + SHA.
    await this.assertNotSuperseded(input.report, run, targetSha);

    // 6. Reject terminal runs; evidence may only attach to active runs.
    if (!ELIGIBLE_STATES.includes(run.state)) {
      throw new RunNotEligibleError(input.runId, run.state);
    }

    // 7. Every criterion must belong to the same canonical run/contract.
    const criterionIds = input.criterionIds ?? [];
    this.validateCriteria(run, criterionIds);

    // 8. Deterministic identities — one idempotency key + evidence id per
    //    source evidence item.
    const reportFp = reportFingerprint(input.report);
    const harnessRunId = input.harnessRunId ?? null;
    const items: ImportItem[] = [];
    for (const finding of input.report.findings) {
      for (const evidence of finding.evidence) {
        const importKey = importIdempotencyKey({
          runId: run.runId,
          targetSha,
          harnessRunId: harnessRunId ?? "",
          reportFingerprint: reportFp,
          findingId: finding.id,
          evidenceId: evidence.id,
        });
        items.push({
          importKey,
          evidenceId: evidenceIdFromImportKey(importKey),
          finding,
          evidence,
          contentHash: evidenceContentHash(evidence),
        });
      }
    }

    // 9. One canonical transaction boundary for every write. Any throw rolls
    //    back the whole import; unexpected failures surface as IMPORT_FAILED.
    const unitOfWork = new SqliteUnitOfWork(this.db);
    const importedAt = this.clock.now();
    const plan: PersistencePlan = {
      run,
      targetSha,
      reportFingerprint: reportFp,
      harnessRunId,
      report: input.report,
      criterionIds,
      items,
      importedAt,
    };

    try {
      return await unitOfWork.execute(({ tx }) => {
        return tx.write(() => this.importInsideTransaction(tx, plan));
      });
    } catch (error) {
      if (isCanonicalImportError(error)) throw error;
      const batchKey =
        items.length > 0
          ? items[0].importKey
          : `${IMPORT_COMMAND_TYPE}:${run.runId}:${targetSha}`;
      throw new ImportFailedError(batchKey, error instanceof Error ? error.message : String(error));
    }
  }

  // ── Pre-transaction validation ──────────────────────────────────────────

  /**
   * A report is superseded when a NEWER report (later generatedAt) with a
   * DIFFERENT fingerprint has already been imported for the same run + SHA.
   * Provenance is read from persisted evidence description columns via the
   * injected repository; rows without provenance (other writers) are
   * ignored.
   */
  private async assertNotSuperseded(
    report: HarnessReport,
    run: CanonicalRun,
    targetSha: string,
  ): Promise<void> {
    const incomingFingerprint = reportFingerprint(report);
    const incomingGeneratedAt = new Date(report.generatedAt).getTime();
    const existing = await this.evidenceRepository.listEvidenceByRun(run.runId);
    for (const ev of existing) {
      if (ev.sha !== targetSha) continue;
      const provenance = parseProvenance(ev.content);
      if (!provenance) continue;
      if (provenance.reportFingerprint === incomingFingerprint) continue;
      if (new Date(provenance.reportGeneratedAt).getTime() > incomingGeneratedAt) {
        throw new ReportSupersededError(run.runId, targetSha);
      }
    }
  }

  /**
   * Every requested criterion must exist in acceptance_criteria for the
   * run's contract AND have a run_acceptance_criteria row bound to the run.
   */
  private validateCriteria(run: CanonicalRun, criterionIds: readonly string[]): void {
    for (const criterionId of criterionIds) {
      const ac = this.db.query("SELECT contract_id FROM acceptance_criteria WHERE id = ?").get(
        criterionId,
      ) as { contract_id: string } | undefined;
      if (!ac || ac.contract_id !== run.contractId) {
        throw new CriterionContractMismatchError(
          criterionId,
          run.contractId,
          ac?.contract_id ?? "(missing)",
        );
      }
      const rac = this.db.query(
        "SELECT id FROM run_acceptance_criteria WHERE run_id = ? AND criterion_id = ?",
      ).get(run.runId, criterionId) as { id: string } | undefined;
      if (!rac) {
        throw new CriterionRunMismatchError(criterionId, run.runId);
      }
    }
  }

  // ── Inside the transaction (STRICTLY SYNCHRONOUS) ───────────────────────

  /** Scoped command idempotency key: `${IMPORT_COMMAND_TYPE}:${runId}:${importKey}`. */
  private scopedKey(runId: string, importKey: string): string {
    return `${IMPORT_COMMAND_TYPE}:${runId}:${importKey}`;
  }

  private importInsideTransaction(
    tx: TransactionManager,
    plan: PersistencePlan,
  ): CanonicalEvidenceImportSummary {
    const { run, targetSha, reportFingerprint, harnessRunId, report, criterionIds, items, importedAt } = plan;
    const evidenceIds: string[] = [];
    const importedFindingIds = new Set<string>();
    let importedEvidenceCount = 0;

    for (const item of items) {
      const reservation = this.reserveImport(tx, run, item, targetSha, importedAt);
      if (reservation.kind === "replay") {
        evidenceIds.push(reservation.evidenceId);
        continue;
      }

      const provenance: EvidenceProvenance = {
        canonicalRunId: run.runId,
        targetSha,
        harnessRunId,
        reportFingerprint,
        reportGeneratedAt: report.generatedAt,
        harnessFindingId: item.finding.id,
        harnessEvidenceId: item.evidence.id,
        sourceEvidenceFingerprint: item.evidence.fingerprint,
        sourceCategory: item.evidence.category,
        sourceCollectedAt: item.evidence.collectedAt,
        contentHash: item.contentHash,
        importIdempotencyKey: item.importKey,
        importedAt: importedAt.toISOString(),
        provenanceVersion: PROVENANCE_VERSION,
      };

      const canonicalEvidence = new Evidence({
        id: item.evidenceId,
        content: item.evidence.summary,
        contentType: `${CONTENT_TYPE_PREFIX}${item.evidence.category}`,
        sha: targetSha,
        runId: run.runId,
        criterionIds,
        status: "current",
        createdAt: importedAt,
      });

      // 1. evidence row (with immutable provenance in description)
      this.hooks.beforeEvidenceWrite(canonicalEvidence);
      this.insertEvidence(tx, canonicalEvidence, provenance);

      // 2. evidence_lifecycle (status current)
      this.hooks.beforeLifecycleWrite(canonicalEvidence);
      this.insertLifecycle(tx, canonicalEvidence);

      // 3. run_criterion_evidence linkage
      for (const criterionId of criterionIds) {
        this.hooks.beforeLinkWrite(canonicalEvidence, criterionId);
        this.insertLink(tx, canonicalEvidence, criterionId);
      }

      // 4. mark the reservation completed (resultId = canonical evidence id)
      this.completeReservation(tx, run, item, targetSha, item.evidenceId, importedAt);

      evidenceIds.push(item.evidenceId);
      importedEvidenceCount++;
      importedFindingIds.add(item.finding.id);
    }

    // 5. One batch event + outbox record per import that wrote evidence.
    if (importedEvidenceCount > 0) {
      const eventId = importEventId(run.runId, targetSha, reportFingerprint);
      this.hooks.beforeEventAppend(eventId);
      this.appendBatchEvent(tx, plan, eventId, importedEvidenceCount, importedAt);
    }

    return {
      runId: run.runId,
      sha: targetSha,
      importedEvidenceCount,
      importedFindingCount: importedFindingIds.size,
      contentType: "harness",
      replayed: importedEvidenceCount === 0 && evidenceIds.length > 0,
      evidenceIds,
    };
  }

  /**
   * INSERT OR IGNORE the scoped reservation inside the transaction, then
   * re-read the row: completed → replay; executing (and not ours) →
   * in_progress; failed → re-acquire; freshly inserted → acquired.
   */
  private reserveImport(
    tx: TransactionManager,
    run: CanonicalRun,
    item: ImportItem,
    targetSha: string,
    importedAt: Date,
  ): { kind: "acquired" } | { kind: "replay"; evidenceId: string } {
    const key = this.scopedKey(run.runId, item.importKey);
    const owner = `${FINGERPRINT_PREFIX}${targetSha}`;
    const startedAt = importedAt.toISOString();

    const insert = this.db.query(
      `INSERT OR IGNORE INTO command_idempotency
        (idempotency_key, command_type, aggregate_type, aggregate_id, status, owner, started_at, created_ts)
       VALUES (?, ?, 'task_run', ?, 'executing', ?, ?, strftime('%s','now'))`,
    ).run(key, IMPORT_COMMAND_TYPE, run.runId, owner, startedAt);

    const row = this.db.query("SELECT * FROM command_idempotency WHERE idempotency_key = ?").get(
      key,
    ) as IdempotencyRow | undefined;
    if (!row) {
      throw new ImportFailedError(item.importKey, "idempotency reservation row missing after insert");
    }

    if (row.status === "completed") {
      if (row.owner !== owner) {
        throw new ImportConflictError(item.importKey);
      }
      const record = new IdempotencyRecord({
        id: key,
        commandType: IMPORT_COMMAND_TYPE,
        taskRunId: run.runId,
        idempotencyKey: item.importKey,
        payloadHash: targetSha,
        status: "completed",
        resultType: "evidence",
        resultId: row.event_id ?? undefined,
        completedAt: row.completed_at ? toInstant(new Date(row.completed_at)) : undefined,
        createdAt: toInstant(new Date(row.started_at)),
      });
      if (!record.resultId) {
        throw new ImportIdempotencyMissingResultError(item.importKey);
      }
      return { kind: "replay", evidenceId: record.resultId };
    }

    if (row.status === "executing") {
      if (insert.changes === 1) return { kind: "acquired" };
      throw new ImportInProgressError(item.importKey);
    }

    if (row.status === "failed") {
      // Released reservation from an interrupted attempt — re-acquire.
      this.db.query(
        `UPDATE command_idempotency
         SET status = 'executing', owner = ?, started_at = ?, completed_at = NULL,
             event_id = NULL, completion_decision_id = NULL, error = NULL
         WHERE idempotency_key = ?`,
      ).run(owner, startedAt, key);
      return { kind: "acquired" };
    }

    throw new ImportFailedError(item.importKey, `unexpected idempotency status "${row.status}"`);
  }

  private insertEvidence(tx: TransactionManager, evidence: Evidence, provenance: EvidenceProvenance): void {
    const createdAt = evidence.createdAt.toISOString();
    const title = evidence.content.length > 240 ? `${evidence.content.slice(0, 240)}…` : evidence.content;
    this.db.query(
      `INSERT INTO evidence
        (id, run_id, evidence_type, title, description, source, source_id, content_hash, file_path, format, size, sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      evidence.id,
      evidence.runId,
      evidence.contentType,
      title,
      canonicalJson(provenance),
      EVIDENCE_SOURCE,
      evidence.id,
      provenance.contentHash,
      EVIDENCE_FORMAT,
      evidence.content.length,
      evidence.sha,
      createdAt,
    );
  }

  private insertLifecycle(tx: TransactionManager, evidence: Evidence): void {
    this.db.query(
      `INSERT OR REPLACE INTO evidence_lifecycle (evidence_id, status, superseded_at, expires_at)
       VALUES (?, 'current', NULL, NULL)`,
    ).run(evidence.id);
  }

  private insertLink(tx: TransactionManager, evidence: Evidence, criterionId: string): void {
    const rac = this.db.query(
      "SELECT id FROM run_acceptance_criteria WHERE run_id = ? AND criterion_id = ?",
    ).get(evidence.runId, criterionId) as { id: string } | undefined;
    if (!rac) {
      throw new CriterionRunMismatchError(criterionId, evidence.runId);
    }
    this.db.query(
      `INSERT OR IGNORE INTO run_criterion_evidence
        (run_acceptance_criterion_id, evidence_id, relationship, linked_at)
       VALUES (?, ?, 'verifies', ?)`,
    ).run(rac.id, evidence.id, evidence.createdAt.toISOString());
  }

  private completeReservation(
    tx: TransactionManager,
    run: CanonicalRun,
    item: ImportItem,
    targetSha: string,
    evidenceId: string,
    importedAt: Date,
  ): void {
    const key = this.scopedKey(run.runId, item.importKey);
    const result = this.db.query(
      `UPDATE command_idempotency
       SET status = 'completed', completed_at = ?, event_id = ?, completion_decision_id = NULL
       WHERE idempotency_key = ? AND status = 'executing'`,
    ).run(importedAt.toISOString(), evidenceId, key);
    if (result.changes === 0) {
      throw new ImportFailedError(item.importKey, "no executing reservation to complete");
    }
  }

  private appendBatchEvent(
    tx: TransactionManager,
    plan: PersistencePlan,
    eventId: string,
    importedEvidenceCount: number,
    importedAt: Date,
  ): void {
    const { run, targetSha, reportFingerprint, harnessRunId } = plan;
    const createdAt = importedAt.toISOString();
    const data = JSON.stringify({
      runId: run.runId,
      sha: targetSha,
      reportFingerprint,
      harnessRunId,
      importedEvidenceCount,
    });

    const versionRow = this.db.query(
      "SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS v FROM events WHERE aggregate_type = 'task_run' AND aggregate_id = ?",
    ).get(run.runId) as { v: number };
    const aggregateVersion = versionRow.v;

    this.db.query(
      `INSERT INTO events
        (event_id, event_type, event_version, causation_id, correlation_id, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
       VALUES (?, 'evidence.imported', 1, NULL, ?, 'task_run', ?, ?, ?, ?, '{}', strftime('%s','now'))`,
    ).run(eventId, run.runId, run.runId, aggregateVersion, createdAt, data);

    const outboxId = this.idGenerator.generate();
    const outboxIdempotencyKey = `${IMPORT_COMMAND_TYPE}:${run.runId}:${reportFingerprint}`;
    this.db.query(
      `INSERT INTO event_outbox
        (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts)
       VALUES (?, ?, 'evidence.imported', ?, ?, 'pending', 0, ?, 'better-harness', strftime('%s','now'))`,
    ).run(outboxId, eventId, run.runId, data, outboxIdempotencyKey);
  }
}

// ── Small sync helpers ────────────────────────────────────────────────────

function isCanonicalImportError(error: unknown): error is CanonicalImportError {
  return (
    error instanceof Error &&
    (error as CanonicalImportError).code !== undefined &&
    typeof (error as CanonicalImportError).code === "string"
  );
}

/**
 * Provenance fields required for the superseded-report check, parsed from
 * the evidence description column. Additional provenance fields are present
 * but untyped here.
 */
interface ParsedProvenance {
  readonly reportFingerprint: string;
  readonly reportGeneratedAt: string;
}

/** Parses provenance JSON from an evidence description; undefined when absent. */
function parseProvenance(description: string): ParsedProvenance | undefined {
  if (!description) return undefined;
  try {
    const parsed: unknown = JSON.parse(description);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.reportFingerprint !== "string") return undefined;
    if (typeof record.reportGeneratedAt !== "string") return undefined;
    return {
      reportFingerprint: record.reportFingerprint,
      reportGeneratedAt: record.reportGeneratedAt,
    };
  } catch {
    return undefined;
  }
}
