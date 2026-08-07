/**
 * Canonical Better Harness evidence import — SQLite integration suite (P1-B).
 *
 * Covers all 27 mandatory cases for the transactional canonical evidence
 * import adapter: canonical run binding, exact-SHA validation, eligibility,
 * superseded-report rejection, criterion contract/run matching, deterministic
 * idempotency, fault-injection rollback, provenance completeness/immutability,
 * harness-run-id containment, completion-gate non-bypass, and schema
 * integrity. Uses the real frozen v0.2.6 schema (SCHEMA_V_0_2_6).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SCHEMA_V_0_2_6 } from "../src/orchestration/persistence/migrations/schema-embed";
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager";
import { SqliteCanonicalRunReader } from "../src/orchestration/evidence/adapters/sqlite-canonical-run-reader";
import { SqliteEvidenceRepository } from "../src/orchestration/evidence/adapters/sqlite-evidence-repository";
import { SqliteIdempotencyRepository } from "../src/orchestration/idempotency/adapters/sqlite-idempotency-repository";
import {
  CanonicalEvidenceImportAdapter,
  type CanonicalEvidencePersistenceHooks,
} from "../src/better-harness/evidence/canonical-evidence-adapter";
import {
  evidenceContentHash,
  evidenceIdFromImportKey,
  importIdempotencyKey,
  reportFingerprint,
} from "../src/better-harness/evidence/import-identity";
import { HarnessReportSchema, type HarnessReport } from "../src/better-harness/contracts/report";
import { evaluateAllGates, type AggregatedGateResult } from "../src/orchestration/completion/completion-evaluator";
import { CompletionGate } from "../src/orchestration/completion/completion-gates";
import { deterministicCleanup } from "./orchestration/harness/cleanup";

// ─── Fixture constants ────────────────────────────────────────────────────

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN_A = "run-a";
const RUN_B = "run-b";
const CONTRACT_A = "contract-a";
const CONTRACT_B = "contract-b";
const FAMILY_A = "family-a";
const FAMILY_B = "family-b";
const CRITERION_A = "ac-a";
const CRITERION_B = "ac-b";
const REQUIREMENT_A = "req-a";
const REQUIREMENT_B = "req-b";

const SYSTEM_CLOCK = { now: () => new Date("2026-08-06T00:00:00.000Z") };
let nextId = 0;
const SEQUENTIAL_ID = { generate: () => `evt_${++nextId}` };

// ─── DB + fixture helpers ─────────────────────────────────────────────────

let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canonical-import-"));
  db = new Database(join(dir, "test.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA_V_0_2_6);
  db.exec("PRAGMA busy_timeout=5000");
  nextId = 0;
});

afterEach(async () => {
  await deterministicCleanup({ db, dir });
});

function buildAdapter(hooks?: CanonicalEvidencePersistenceHooks): CanonicalEvidenceImportAdapter {
  const tx = createTransactionManager(db);
  return new CanonicalEvidenceImportAdapter({
    db,
    runReader: new SqliteCanonicalRunReader(db),
    evidenceRepository: new SqliteEvidenceRepository(db, tx),
    idempotencyRepository: new SqliteIdempotencyRepository(db, tx),
    clock: SYSTEM_CLOCK,
    idGenerator: SEQUENTIAL_ID,
    persistenceHooks: hooks,
  });
}

interface ContractSeed {
  contractId: string;
  familyId: string;
  criterionId: string;
  requirementId: string;
}

function seedContract(seed: ContractSeed): void {
  db.query(
    `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
     VALUES (?, ?, 'Contract family', 'system', '2026-08-06T00:00:00.000Z')`,
  ).run(seed.familyId, seed.familyId);
  db.query(
    `INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
     VALUES (?, ?, 1, ?, 'Contract description',
             'https://github.com/heidi-dang/FlowDeck',
             '0000000000000000000000000000000000000000', 'system', '2026-08-06T00:00:00.000Z')`,
  ).run(seed.contractId, seed.familyId, seed.contractId);
  db.query(
    `INSERT OR IGNORE INTO requirements (id, contract_id, title, description, priority, sort_order)
     VALUES (?, ?, 'Requirement', 'Requirement description', 'high', 0)`,
  ).run(seed.requirementId, seed.contractId);
  db.query(
    `INSERT OR IGNORE INTO acceptance_criteria (id, contract_id, requirement_id, title, description, verification_method, priority, sort_order)
     VALUES (?, ?, ?, 'Criterion', 'Criterion description', 'test', 'high', 0)`,
  ).run(seed.criterionId, seed.contractId, seed.requirementId);
  db.query(
    `INSERT OR IGNORE INTO contract_lifecycle (contract_id, family_id, status, updated_ts)
     VALUES (?, ?, 'active', 1722900000)`,
  ).run(seed.contractId, seed.familyId);
}

interface RunSeed {
  runId: string;
  contractId: string;
  sha?: string | null;
  state?: string;
  criterionId?: string | null;
}

function seedRun(seed: RunSeed): void {
  db.query(
    `INSERT OR IGNORE INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, current_sha, repo_branch, created_at, created_ts)
     VALUES (?, ?, 'simple', ?, 1,
             '0000000000000000000000000000000000000000', ?, 'main',
             '2026-08-06T00:00:00.000Z', 1722900000)`,
  ).run(
    seed.runId,
    seed.contractId,
    seed.state ?? "created",
    seed.sha === undefined ? SHA_A : seed.sha,
  );
  if (seed.criterionId) {
    db.query(
      `INSERT OR IGNORE INTO run_acceptance_criteria (id, run_id, criterion_id, status)
       VALUES (?, ?, ?, 'pending')`,
    ).run(`rac-${seed.runId}-${seed.criterionId}`, seed.runId, seed.criterionId);
  }
}

/** Seeds the canonical baseline fixture: contract-a + run-a bound to it. */
function seedCanonicalBaseline(): void {
  seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
  seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A, criterionId: CRITERION_A });
}

interface ReportOverrides {
  sourceRevision?: string;
  generatedAt?: string;
  overallScore?: number;
  findingId?: string;
  evidenceId?: string;
  evidenceSummary?: string;
  evidenceFingerprint?: string;
  evidenceCollectedAt?: string;
}

function makeReport(overrides: ReportOverrides = {}): HarnessReport {
  const raw = {
    schemaVersion: 1,
    engineVersion: "1.0.0",
    scoringVersion: "1",
    generatedAt: overrides.generatedAt ?? "2026-08-06T12:00:00.000Z",
    sourceRevision: overrides.sourceRevision ?? SHA_A,
    project: { name: "test", directory: "/tmp/test" },
    overallScore: overrides.overallScore ?? 80,
    evidenceCoverage: 50,
    dimensions: [],
    findings: [
      {
        id: overrides.findingId ?? "f1",
        title: "Finding one",
        dimension: "reliable-delivery" as const,
        priority: "high" as const,
        status: "pending" as const,
        cause: "cause",
        impact: "impact",
        expectedOutput: "expected",
        evidence: [
          {
            id: overrides.evidenceId ?? "e1",
            category: "customization" as const,
            source: "workspace",
            summary: overrides.evidenceSummary ?? "evidence one summary",
            confidence: 0.9,
            collectedAt: overrides.evidenceCollectedAt ?? "2026-08-06T11:00:00.000Z",
            fingerprint: overrides.evidenceFingerprint ?? "fp1",
          },
        ],
        recommendedVehicle: "rule" as const,
        allowedPaths: ["/tmp"],
        validationRequirements: ["req"],
        acceptanceCriteria: ["ac"],
        firstSeenAt: "2026-08-06T11:00:00.000Z",
        lastSeenAt: "2026-08-06T12:00:00.000Z",
      },
    ],
    sessions: {
      analyzed: 0,
      longSessions: 0,
      failedSessions: 0,
      repeatedFailures: 0,
      compactions: 0,
      permissionInterruptions: 0,
    },
    assets: {
      agents: 0,
      skills: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
      scripts: 0,
      workflows: 0,
      tests: 0,
      lessons: 0,
      memoryNodes: 0,
    },
  };
  return HarnessReportSchema.parse(raw);
}

function expectedEvidenceId(runId: string, sha: string, report: HarnessReport, harnessRunId = ""): string {
  const importKey = importIdempotencyKey({
    runId,
    targetSha: sha,
    harnessRunId,
    reportFingerprint: reportFingerprint(report),
    findingId: report.findings[0].id,
    evidenceId: report.findings[0].evidence[0].id,
  });
  return evidenceIdFromImportKey(importKey);
}

function countRows(table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function completedIdempotencyCount(): number {
  return (db.query(
    "SELECT COUNT(*) AS n FROM command_idempotency WHERE status = 'completed'",
  ).get() as { n: number }).n;
}

// ─── 1–3. Canonical run existence / arbitrary-run rejection ────────────────

describe("canonical run binding", () => {
  it("1. existing canonical run with matching SHA succeeds", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({ runId: RUN_A, report: makeReport() });

    expect(summary.runId).toBe(RUN_A);
    expect(summary.sha).toBe(SHA_A);
    expect(summary.importedEvidenceCount).toBe(1);
    expect(summary.importedFindingCount).toBe(1);
    expect(summary.replayed).toBe(false);
    expect(summary.evidenceIds).toHaveLength(1);
    expect(countRows("evidence")).toBe(1);
    expect(countRows("evidence_lifecycle")).toBe(1);
    expect(countRows("events")).toBe(1);
    expect(countRows("event_outbox")).toBe(1);
    expect(completedIdempotencyCount()).toBe(1);
  });

  it("2. unknown canonical run fails with CANONICAL_RUN_NOT_FOUND", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    const adapter = buildAdapter();
    await expect(
      adapter.importReport({ runId: "run-missing", report: makeReport() }),
    ).rejects.toMatchObject({ code: "CANONICAL_RUN_NOT_FOUND" });
    expect(countRows("evidence")).toBe(0);
  });

  it("3. arbitrary task_run_* string fails (does not exist in task_runs)", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    const adapter = buildAdapter();
    for (const bogus of ["task_run_arbitrary", "task_run_1", "run_harness_xyz"]) {
      await expect(
        adapter.importReport({ runId: bogus, report: makeReport() }),
      ).rejects.toMatchObject({ code: "CANONICAL_RUN_NOT_FOUND" });
    }
    expect(countRows("evidence")).toBe(0);
  });
});

// ─── 4–6. SHA validation ──────────────────────────────────────────────────

describe("exact SHA validation", () => {
  it("4. missing canonical current SHA fails with RUN_CURRENT_SHA_MISSING", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: null });
    const adapter = buildAdapter();
    await expect(
      adapter.importReport({ runId: RUN_A, report: makeReport() }),
    ).rejects.toMatchObject({ code: "RUN_CURRENT_SHA_MISSING" });
    expect(countRows("evidence")).toBe(0);
  });

  it("5. requested SHA mismatch fails with RUN_SHA_MISMATCH", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A });
    const adapter = buildAdapter();
    const report = makeReport({ sourceRevision: SHA_B });
    await expect(
      adapter.importReport({ runId: RUN_A, sha: SHA_B, report }),
    ).rejects.toMatchObject({ code: "RUN_SHA_MISMATCH" });
    expect(countRows("evidence")).toBe(0);
  });

  it("6. report sourceRevision mismatch fails with REPORT_SHA_MISMATCH", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A });
    const adapter = buildAdapter();
    const report = makeReport({ sourceRevision: SHA_B });
    await expect(
      adapter.importReport({ runId: RUN_A, sha: SHA_A, report }),
    ).rejects.toMatchObject({ code: "REPORT_SHA_MISMATCH" });
    expect(countRows("evidence")).toBe(0);
  });
});

// ─── 7–8. Superseded + eligibility ────────────────────────────────────────

describe("superseded reports and eligibility", () => {
  it("7. stale report fails with REPORT_SUPERSEDED (newer report imported first)", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    // Newer report (different fingerprint) imported first.
    await adapter.importReport({
      runId: RUN_A,
      report: makeReport({ generatedAt: "2026-08-06T14:00:00.000Z", overallScore: 82 }),
    });
    // Older report with a different fingerprint is superseded.
    await expect(
      adapter.importReport({
        runId: RUN_A,
        report: makeReport({ generatedAt: "2026-08-06T10:00:00.000Z", overallScore: 78 }),
      }),
    ).rejects.toMatchObject({ code: "REPORT_SUPERSEDED" });
    expect(countRows("evidence")).toBe(1);
  });

  it("8. ineligible terminal run fails with RUN_NOT_ELIGIBLE", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    const adapter = buildAdapter();
    for (const [runId, state] of [["run-completed", "completed"], ["run-failed", "failed"], ["run-cancelled", "cancelled"]] as const) {
      seedRun({ runId, contractId: CONTRACT_A, sha: SHA_A, state });
      await expect(
        adapter.importReport({ runId, report: makeReport() }),
      ).rejects.toMatchObject({ code: "RUN_NOT_ELIGIBLE" });
      expect(countRows("evidence")).toBe(0);
    }
  });
});

// ─── 9–11. Criterion binding ──────────────────────────────────────────────

describe("criterion contract/run binding", () => {
  it("9. cross-run criterion fails with CRITERION_RUN_MISMATCH", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A, criterionId: CRITERION_A });
    seedRun({ runId: RUN_B, contractId: CONTRACT_A, sha: SHA_A }); // criterion NOT bound to run-b
    const adapter = buildAdapter();
    await expect(
      adapter.importReport({ runId: RUN_B, report: makeReport(), criterionIds: [CRITERION_A] }),
    ).rejects.toMatchObject({ code: "CRITERION_RUN_MISMATCH" });
    expect(countRows("evidence")).toBe(0);
  });

  it("10. cross-contract criterion fails with CRITERION_CONTRACT_MISMATCH", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedContract({ contractId: CONTRACT_B, familyId: FAMILY_B, criterionId: CRITERION_B, requirementId: REQUIREMENT_B });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A });
    const adapter = buildAdapter();
    // ac-b belongs to contract-b; run-a is contract-a.
    await expect(
      adapter.importReport({ runId: RUN_A, report: makeReport(), criterionIds: [CRITERION_B] }),
    ).rejects.toMatchObject({ code: "CRITERION_CONTRACT_MISMATCH" });
    expect(countRows("evidence")).toBe(0);
  });

  it("11. valid criterion linkage succeeds (run_criterion_evidence rows exist)", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({ runId: RUN_A, report: makeReport(), criterionIds: [CRITERION_A] });

    const links = db.query(
      `SELECT rce.run_acceptance_criterion_id, rce.evidence_id, rce.relationship
       FROM run_criterion_evidence rce
       WHERE rce.evidence_id = ?`,
    ).all(summary.evidenceIds[0]) as { run_acceptance_criterion_id: string; evidence_id: string; relationship: string }[];
    expect(links).toHaveLength(1);
    expect(links[0].run_acceptance_criterion_id).toBe(`rac-${RUN_A}-${CRITERION_A}`);
    expect(links[0].evidence_id).toBe(summary.evidenceIds[0]);
    expect(links[0].relationship).toBe("verifies");
  });
});

// ─── 12–14. Idempotency ───────────────────────────────────────────────────

describe("idempotency and retry", () => {
  it("12. sequential duplicate import is idempotent", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const report = makeReport();
    const first = await adapter.importReport({ runId: RUN_A, report });
    const second = await adapter.importReport({ runId: RUN_A, report });

    expect(second.importedEvidenceCount).toBe(0);
    expect(second.replayed).toBe(true);
    expect(second.evidenceIds).toEqual(first.evidenceIds);
    expect(second.evidenceIds).toHaveLength(1);
    expect(countRows("evidence")).toBe(1);
    expect(completedIdempotencyCount()).toBe(1);
  });

  it("13. concurrent duplicate import creates one result", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const report = makeReport();
    const [a, b] = await Promise.all([
      adapter.importReport({ runId: RUN_A, report }),
      adapter.importReport({ runId: RUN_A, report }),
    ]);

    expect(countRows("evidence")).toBe(1);
    expect(completedIdempotencyCount()).toBe(1);
    expect(a.evidenceIds).toEqual(b.evidenceIds);
    // One import wrote, the other replayed — no in-progress error surfaced.
    const imported = a.importedEvidenceCount + b.importedEvidenceCount;
    expect(imported).toBe(1);
  });

  it("14. interrupted retry resumes deterministically", async () => {
    seedCanonicalBaseline();
    const report = makeReport();
    const expectedId = expectedEvidenceId(RUN_A, SHA_A, report);

    // First attempt fails at the evidence write → whole transaction rolls back.
    const failingAdapter = buildAdapter({
      beforeEvidenceWrite: () => {
        throw new Error("injected evidence write failure");
      },
    });
    await expect(
      failingAdapter.importReport({ runId: RUN_A, report }),
    ).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    // Nothing persisted: no evidence, no completed idempotency row.
    expect(countRows("evidence")).toBe(0);
    expect(countRows("evidence_lifecycle")).toBe(0);
    expect(completedIdempotencyCount()).toBe(0);
    expect(countRows("events")).toBe(0);

    // Retry succeeds with the SAME deterministic evidence id.
    const adapter = buildAdapter();
    const retry = await adapter.importReport({ runId: RUN_A, report });
    expect(retry.evidenceIds[0]).toBe(expectedId);
    expect(retry.replayed).toBe(false);
    const row = db.query("SELECT id FROM evidence WHERE id = ?").get(expectedId) as { id: string } | undefined;
    expect(row).not.toBeNull();
  });
});

// ─── 15–18. Fault injection rollback ──────────────────────────────────────

describe("fault-injection rollback", () => {
  it("15. evidence-save failure rolls back idempotency", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter({
      beforeEvidenceWrite: () => {
        throw new Error("injected evidence failure");
      },
    });
    await expect(adapter.importReport({ runId: RUN_A, report: makeReport() })).rejects.toMatchObject({
      code: "IMPORT_FAILED",
    });
    expect(countRows("evidence")).toBe(0);
    expect(countRows("evidence_lifecycle")).toBe(0);
    expect(countRows("run_criterion_evidence")).toBe(0);
    expect(completedIdempotencyCount()).toBe(0);
    expect(countRows("command_idempotency")).toBe(0);
    expect(countRows("events")).toBe(0);
    expect(countRows("event_outbox")).toBe(0);
  });

  it("16. lifecycle failure rolls back evidence", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter({
      beforeLifecycleWrite: () => {
        throw new Error("injected lifecycle failure");
      },
    });
    await expect(adapter.importReport({ runId: RUN_A, report: makeReport() })).rejects.toMatchObject({
      code: "IMPORT_FAILED",
    });
    expect(countRows("evidence")).toBe(0);
    expect(countRows("evidence_lifecycle")).toBe(0);
    expect(completedIdempotencyCount()).toBe(0);
  });

  it("17. criterion-link failure rolls back evidence", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter({
      beforeLinkWrite: () => {
        throw new Error("injected link failure");
      },
    });
    await expect(
      adapter.importReport({ runId: RUN_A, report: makeReport(), criterionIds: [CRITERION_A] }),
    ).rejects.toMatchObject({ code: "IMPORT_FAILED" });
    expect(countRows("evidence")).toBe(0);
    expect(countRows("run_criterion_evidence")).toBe(0);
    expect(completedIdempotencyCount()).toBe(0);
  });

  it("18. event/outbox failure rolls back all applicable writes", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter({
      beforeEventAppend: () => {
        throw new Error("injected event failure");
      },
    });
    await expect(adapter.importReport({ runId: RUN_A, report: makeReport() })).rejects.toMatchObject({
      code: "IMPORT_FAILED",
    });
    expect(countRows("evidence")).toBe(0);
    expect(countRows("evidence_lifecycle")).toBe(0);
    expect(countRows("run_criterion_evidence")).toBe(0);
    expect(completedIdempotencyCount()).toBe(0);
    expect(countRows("events")).toBe(0);
    expect(countRows("event_outbox")).toBe(0);
  });
});

// ─── 19–23. Provenance and identity determinism ───────────────────────────

describe("provenance and deterministic identity", () => {
  const PROVENANCE_FIELDS = [
    "canonicalRunId",
    "targetSha",
    "harnessRunId",
    "reportFingerprint",
    "reportGeneratedAt",
    "harnessFindingId",
    "harnessEvidenceId",
    "sourceEvidenceFingerprint",
    "sourceCategory",
    "sourceCollectedAt",
    "contentHash",
    "importIdempotencyKey",
    "importedAt",
    "provenanceVersion",
  ];

  it("19. provenance is complete (all 13 fields present on the evidence description)", async () => {
    seedCanonicalBaseline();
    const report = makeReport();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({
      runId: RUN_A,
      report,
      harnessRunId: "run_harness_x",
    });

    const row = db.query("SELECT description FROM evidence WHERE id = ?").get(summary.evidenceIds[0]) as {
      description: string;
    };
    const provenance = JSON.parse(row.description) as Record<string, unknown>;
    for (const field of PROVENANCE_FIELDS) {
      expect(provenance[field]).toBeDefined();
    }
    expect(provenance.canonicalRunId).toBe(RUN_A);
    expect(provenance.targetSha).toBe(SHA_A);
    expect(provenance.harnessRunId).toBe("run_harness_x");
    expect(provenance.reportFingerprint).toBe(reportFingerprint(report));
    expect(provenance.reportGeneratedAt).toBe(report.generatedAt);
    expect(provenance.harnessFindingId).toBe("f1");
    expect(provenance.harnessEvidenceId).toBe("e1");
    expect(provenance.sourceEvidenceFingerprint).toBe("fp1");
    expect(provenance.sourceCategory).toBe("customization");
    expect(provenance.sourceCollectedAt).toBe("2026-08-06T11:00:00.000Z");
    expect(provenance.contentHash).toBe(evidenceContentHash(report.findings[0].evidence[0]));
    expect(provenance.importIdempotencyKey).toBe(
      importIdempotencyKey({
        runId: RUN_A,
        targetSha: SHA_A,
        harnessRunId: "run_harness_x",
        reportFingerprint: reportFingerprint(report),
        findingId: report.findings[0].id,
        evidenceId: report.findings[0].evidence[0].id,
      }),
    );
    expect(provenance.provenanceVersion).toBe(1);
  });

  it("20. provenance is immutable (evidence cannot be updated or deleted)", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({ runId: RUN_A, report: makeReport() });
    const evidenceId = summary.evidenceIds[0];
    const original = db.query("SELECT description FROM evidence WHERE id = ?").get(evidenceId) as { description: string };

    expect(() =>
      db.query("UPDATE evidence SET description = 'tampered' WHERE id = ?").run(evidenceId),
    ).toThrow(/immutable|Cannot modify evidence/);
    expect(() =>
      db.query("DELETE FROM evidence WHERE id = ?").run(evidenceId),
    ).toThrow(/cannot be deleted/);

    const after = db.query("SELECT description FROM evidence WHERE id = ?").get(evidenceId) as { description: string };
    expect(after.description).toBe(original.description);
    expect(countRows("evidence")).toBe(1);
  });

  it("21. content hash is deterministic (same evidence → same evidenceContentHash)", async () => {
    seedCanonicalBaseline();
    const report = makeReport();
    const hash1 = evidenceContentHash(report.findings[0].evidence[0]);
    const hash2 = evidenceContentHash(report.findings[0].evidence[0]);
    expect(hash1).toBe(hash2);

    const adapter = buildAdapter();
    const summary = await adapter.importReport({ runId: RUN_A, report });
    const row = db.query("SELECT content_hash FROM evidence WHERE id = ?").get(summary.evidenceIds[0]) as {
      content_hash: string;
    };
    expect(row.content_hash).toBe(hash1);
  });

  it("22. changed SHA creates a distinct identity", async () => {
    seedContract({ contractId: CONTRACT_A, familyId: FAMILY_A, criterionId: CRITERION_A, requirementId: REQUIREMENT_A });
    seedRun({ runId: RUN_A, contractId: CONTRACT_A, sha: SHA_A });
    seedRun({ runId: RUN_B, contractId: CONTRACT_A, sha: SHA_B });
    const adapter = buildAdapter();

    const reportA = makeReport({ sourceRevision: SHA_A });
    const reportB = makeReport({ sourceRevision: SHA_B });
    const a = await adapter.importReport({ runId: RUN_A, report: reportA });
    const b = await adapter.importReport({ runId: RUN_B, report: reportB });

    expect(a.evidenceIds[0]).not.toBe(b.evidenceIds[0]);
    expect(countRows("evidence")).toBe(2);
    const runA = db.query("SELECT run_id FROM evidence WHERE id = ?").get(a.evidenceIds[0]) as { run_id: string };
    const runB = db.query("SELECT run_id FROM evidence WHERE id = ?").get(b.evidenceIds[0]) as { run_id: string };
    expect(runA.run_id).toBe(RUN_A);
    expect(runB.run_id).toBe(RUN_B);
  });

  it("23. changed report creates a distinct fingerprint", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const report1 = makeReport({ generatedAt: "2026-08-06T12:00:00.000Z", overallScore: 80 });
    const report2 = makeReport({ generatedAt: "2026-08-06T13:00:00.000Z", overallScore: 81 });

    const fp1 = reportFingerprint(report1);
    const fp2 = reportFingerprint(report2);
    expect(fp1).not.toBe(fp2);

    const first = await adapter.importReport({ runId: RUN_A, report: report1 });
    const second = await adapter.importReport({ runId: RUN_A, report: report2 });

    expect(first.evidenceIds[0]).not.toBe(second.evidenceIds[0]);
    expect(countRows("evidence")).toBe(2);
  });
});

// ─── 24–26. Containment and completion non-bypass ─────────────────────────

describe("harness-run containment and completion gates", () => {
  it("24. harness run ID never becomes the canonical run ID", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({
      runId: RUN_A,
      report: makeReport(),
      harnessRunId: "run_harness_x",
    });
    const row = db.query("SELECT run_id FROM evidence WHERE id = ?").get(summary.evidenceIds[0]) as { run_id: string };
    expect(row.run_id).toBe(RUN_A);
    expect(row.run_id).not.toBe("run_harness_x");
    expect(row.run_id.startsWith("run_harness_")).toBe(false);
  });

  it("25. import cannot create a completion decision", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    await adapter.importReport({ runId: RUN_A, report: makeReport() });
    expect(countRows("completion_decisions")).toBe(0);
    // The import also never touched task-run state.
    const runRow = db.query("SELECT state, completion_sha FROM task_runs WHERE run_id = ?").get(RUN_A) as {
      state: string;
      completion_sha: string | null;
    };
    expect(runRow.state).toBe("created");
    expect(runRow.completion_sha).toBeNull();
  });

  it("26. imported evidence cannot bypass completion gates", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    const summary = await adapter.importReport({
      runId: RUN_A,
      report: makeReport(),
      criterionIds: [CRITERION_A],
    });

    const evidenceItems = [{
      id: summary.evidenceIds[0],
      sha: SHA_A,
      runId: RUN_A,
      status: "current" as const,
      criterionIds: [CRITERION_A],
    }];
    const criteria = [{ id: CRITERION_A, description: "criterion", priority: "critical" as const }];
    const requirements = [{ id: REQUIREMENT_A, description: "requirement", priority: "critical" as const }];

    // (a) Only imported evidence, no passing verification → gates still fail.
    const fail: AggregatedGateResult = evaluateAllGates({
      runId: RUN_A,
      currentSha: SHA_A,
      assignmentsComplete: false,
      verificationResults: [],
      acceptanceCriteria: criteria,
      requirements,
      evidenceItems,
    });
    expect(fail.allPassed).toBe(false);
    expect(fail.failingGates.some((g) => g.gate === CompletionGate.ASSIGNMENTS_COMPLETE)).toBe(true);
    expect(fail.failingGates.some((g) => g.gate === CompletionGate.EXACT_SHA_VERIFIED)).toBe(true);
    expect(fail.failingGates.some((g) => g.gate === CompletionGate.CRITICAL_CRITERIA_PASSED)).toBe(true);
    expect(fail.failingGates.some((g) => g.gate === CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED)).toBe(true);

    // (b) Imported evidence only satisfies MANDATORY_EVIDENCE_PRESENT when
    //     every other gate input independently passes.
    const pass: AggregatedGateResult = evaluateAllGates({
      runId: RUN_A,
      currentSha: SHA_A,
      assignmentsComplete: true,
      verificationResults: [
        {
          id: "vr-1",
          runId: RUN_A,
          ruleId: CRITERION_A,
          ruleDescription: "criterion",
          required: true,
          status: "passed",
          targetSha: SHA_A,
          evidenceIds: [summary.evidenceIds[0]],
        },
        {
          id: "vr-2",
          runId: RUN_A,
          ruleId: REQUIREMENT_A,
          ruleDescription: "requirement",
          required: false,
          status: "passed",
          targetSha: SHA_A,
          evidenceIds: [],
        },
      ],
      acceptanceCriteria: criteria,
      requirements,
      evidenceItems,
    });
    expect(pass.allPassed).toBe(true);
  });
});

// ─── 27. Integrity ────────────────────────────────────────────────────────

describe("schema integrity", () => {
  it("27. canonical SQLite integration passes foreign-key and integrity checks", async () => {
    seedCanonicalBaseline();
    const adapter = buildAdapter();
    await adapter.importReport({ runId: RUN_A, report: makeReport(), criterionIds: [CRITERION_A] });
    await adapter.importReport({ runId: RUN_A, report: makeReport() }); // idempotent replay

    const fkViolations = db.query("PRAGMA foreign_key_check").all();
    expect(fkViolations).toHaveLength(0);

    // Immutability triggers are present in the applied schema.
    const triggers = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('tr_evidence_immutable_update', 'tr_evidence_immutable_delete')",
    ).all() as { name: string }[];
    expect(triggers.map((t) => t.name).sort()).toEqual([
      "tr_evidence_immutable_delete",
      "tr_evidence_immutable_update",
    ]);

    // Every evidence row has exactly one lifecycle row and consistent run linkage.
    const orphans = db.query(
      `SELECT e.id FROM evidence e
       LEFT JOIN evidence_lifecycle lc ON lc.evidence_id = e.id
       WHERE lc.evidence_id IS NULL`,
    ).all();
    expect(orphans).toHaveLength(0);

    const linkRuns = db.query(
      `SELECT DISTINCT e.run_id FROM evidence e
       JOIN run_criterion_evidence rce ON rce.evidence_id = e.id
       WHERE e.run_id != (SELECT run_id FROM run_acceptance_criteria WHERE id = rce.run_acceptance_criterion_id)`,
    ).all();
    expect(linkRuns).toHaveLength(0);
  });
});
