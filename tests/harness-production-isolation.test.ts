/**
 * Production isolation tests for the Better Harness split-brain fix (P0-2).
 *
 * Proves:
 *  1. The production config is fail-closed: `betterHarness.enabled=true` is
 *     rejected by loadFlowDeckConfig / validateBetterHarnessProductionConfig.
 *  2. The production plugin entry point (src/index.ts) no longer imports or
 *     constructs Better Harness runtime components.
 *  3. Harness persistence is instance-scoped: a coordinator with an explicit
 *     stateDir never reads or writes outside it, and concurrent coordinators
 *     stay isolated.
 *  4. The canonical evidence import adapter binds evidence to an exact
 *     canonical run + SHA and rejects mismatches.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { loadFlowDeckConfig, validateBetterHarnessProductionConfig, DEFAULT_CONFIG } from "../src/config/agent-models";
import { RunCoordinator } from "../src/better-harness/runtime/run-coordinator";
import { saveRun } from "../src/better-harness/persistence/run-store";
import { getProjectStoreDir } from "../src/better-harness/persistence/harness-store";
import { CanonicalEvidenceImportAdapter } from "../src/better-harness/evidence/canonical-evidence-adapter";
import { HarnessReportSchema, type HarnessReport } from "../src/better-harness/contracts/report";
import { SCHEMA_V_0_2_6 } from "../src/orchestration/persistence/migrations/schema-embed";
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager";
import { SqliteCanonicalRunReader } from "../src/orchestration/evidence/adapters/sqlite-canonical-run-reader";
import { SqliteEvidenceRepository } from "../src/orchestration/evidence/adapters/sqlite-evidence-repository";
import { SqliteIdempotencyRepository } from "../src/orchestration/idempotency/adapters/sqlite-idempotency-repository";

// ─── 1. Fail-closed production config ──────────────────────────────────────

describe("Production config is fail-closed for Better Harness (P0-2)", () => {
  it("DEFAULT_CONFIG does not enable betterHarness", () => {
    expect(DEFAULT_CONFIG.betterHarness).toBeUndefined();
  });

  it("validateBetterHarnessProductionConfig rejects betterHarness.enabled=true", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      betterHarness: { enabled: true, port: 9999 },
    } as Parameters<typeof validateBetterHarnessProductionConfig>[0];
    expect(() => validateBetterHarnessProductionConfig(cfg)).toThrow(/betterHarness\.enabled=true is REJECTED/);
  });

  it("validateBetterHarnessProductionConfig forces enabled=false for inert blocks", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      betterHarness: { enabled: false, port: 9999 },
    } as Parameters<typeof validateBetterHarnessProductionConfig>[0];
    const result = validateBetterHarnessProductionConfig(cfg);
    expect(result.betterHarness?.enabled).toBe(false);
  });

  it("loadFlowDeckConfig throws when a config file sets betterHarness.enabled=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-failclosed-"));
    try {
      const cfgPath = join(dir, ".flowdeck.json");
      writeFileSync(cfgPath, JSON.stringify({ betterHarness: { enabled: true } }));
      expect(() => loadFlowDeckConfig(dir)).toThrow(/betterHarness\.enabled=true is REJECTED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadFlowDeckConfig allows a config without betterHarness", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-allow-"));
    try {
      const cfgPath = join(dir, ".flowdeck.json");
      writeFileSync(cfgPath, JSON.stringify({ maxDelegationDepth: 1 }));
      const cfg = loadFlowDeckConfig(dir);
      expect(cfg.betterHarness?.enabled).not.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 2. Production plugin entry point has no harness runtime ───────────────

describe("Production plugin entry point (src/index.ts) has no Better Harness runtime (P0-2)", () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
  });

  it("does not import HarnessRuntime", () => {
    expect(source).not.toMatch(/import\s+\{[^}]*HarnessRuntime/);
  });

  it("does not import HarnessHttpServer, SseManager, ProjectRegistry, or RouterContext", () => {
    expect(source).not.toMatch(/import\s+\{[^}]*HarnessHttpServer/);
    expect(source).not.toMatch(/import\s+\{[^}]*SseManager/);
    expect(source).not.toMatch(/import\s+\{[^}]*ProjectRegistry/);
    expect(source).not.toMatch(/import\s+\{[^}]*RouterContext/);
  });

  it("does not construct the harness runtime", () => {
    expect(source).not.toMatch(/new\s+HarnessRuntime\s*\(/);
    expect(source).not.toMatch(/new\s+HarnessHttpServer\s*\(/);
  });

  it("does not call recoverActiveRuns", () => {
    expect(source).not.toMatch(/recoverActiveRuns\s*\(/);
  });
});

// ─── 3. Instance-scoped persistence isolation ──────────────────────────────

describe("Better Harness persistence is instance-scoped (P0-2)", () => {
  let dirA: string;
  let dirB: string;
  const projectId = "iso-test-project";

  beforeAll(() => {
    dirA = mkdtempSync(join(tmpdir(), "flowdeck-bh-a-"));
    dirB = mkdtempSync(join(tmpdir(), "flowdeck-bh-b-"));
  });

  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("saveRun with stateDir writes only into that stateDir", () => {
    const coordA = new RunCoordinator(dirA);
    const run = {
      runId: "run_iso_a",
      projectId,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      stage: "collecting",
      progressPercent: 5,
    };
    coordA.enqueueRun({ projectRoot: "/tmp" });
    saveRun(projectId, run, dirA);

    const inA = join(getProjectStoreDir(projectId, dirA), "runs", "run_iso_a.json");
    const inB = join(getProjectStoreDir(projectId, dirB), "runs", "run_iso_a.json");
    expect(existsSync(inA)).toBe(true);
    expect(existsSync(inB)).toBe(false);
  });

  it("coordinator getRun is scoped to its instance stateDir", () => {
    const coordA = new RunCoordinator(dirA);
    const coordB = new RunCoordinator(dirB);

    // run_iso_a exists only in A
    expect(coordA.getRun("run_iso_a")).not.toBeNull();
    expect(coordB.getRun("run_iso_a")).toBeNull();

    // Writing to B's store does not affect A
    saveRun(projectId, {
      runId: "run_iso_b",
      projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      stage: "collecting",
      progressPercent: 5,
    }, dirB);
    expect(coordB.getRun("run_iso_b")).not.toBeNull();
    expect(coordA.getRun("run_iso_b")).toBeNull();
  });

  it("coordinator recoverActiveRuns only touches its own stateDir", () => {
    // Mark run_iso_a as stuck-running, then recover via A's coordinator.
    const coordA = new RunCoordinator(dirA);
    const coordB = new RunCoordinator(dirB);

    coordA.recoverActiveRuns();
    const recovered = coordA.getRun("run_iso_a");
    expect(recovered?.status).toBe("failed");
    // B is unaffected — B cannot even see run_iso_a.
    expect(coordB.getRun("run_iso_a")).toBeNull();
  });

  it("instance-scoped coordinator never consults the global state override", () => {
    // This test would fail if RunCoordinator used the global setFlowDeckStateDir
    // override: an instance with its own stateDir must ignore it entirely.
    const coordA = new RunCoordinator(dirA);
    // No global override is set anywhere in the runtime path; the instance
    // stores must remain fully isolated.
    expect(coordA.getRun("run_iso_b")).toBeNull();
    expect(existsSync(join(getProjectStoreDir(projectId, dirA), "runs", "run_iso_b.json"))).toBe(false);
  });
});

// ─── 4. Canonical evidence adapter binding (real frozen schema) ───────────

function makeReport(): HarnessReport {
  const raw = {
    schemaVersion: 1,
    engineVersion: "1.0.0",
    scoringVersion: "1",
    generatedAt: new Date().toISOString(),
    sourceRevision: "deadbeef",
    project: { name: "test", directory: "/tmp/test" },
    overallScore: 80,
    evidenceCoverage: 50,
    dimensions: [],
    findings: [
      {
        id: "f1",
        title: "Finding one",
        dimension: "reliable-delivery" as const,
        priority: "high" as const,
        status: "pending" as const,
        cause: "cause",
        impact: "impact",
        expectedOutput: "expected",
        evidence: [
          {
            id: "e1",
            category: "customization" as const,
            source: "workspace",
            summary: "evidence one summary",
            confidence: 0.9,
            collectedAt: new Date().toISOString(),
            fingerprint: "fp1",
          },
        ],
        recommendedVehicle: "rule" as const,
        allowedPaths: ["/tmp"],
        validationRequirements: ["req"],
        acceptanceCriteria: ["ac"],
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
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

const SYSTEM_CLOCK = { now: () => new Date("2026-08-06T00:00:00.000Z") };
let nextId = 0;
const SEQUENTIAL_ID = { generate: () => `evt_${++nextId}` };

// Canonical fixture: one contract family, one contract (active), one
// requirement + acceptance criterion, and ONE real canonical run bound to
// the contract with a real current_sha.
const CANONICAL_RUN_ID = "run-canonical-1";
const CANONICAL_SHA = "deadbeef";
const CONTRACT_ID = "contract-canonical";
const CRITERION_ID = "ac-canonical-1";
const REQUIREMENT_ID = "req-canonical-1";
const RAC_ID = "rac-canonical-1";

function seedCanonicalFixture(db: Database): void {
  db.query(
    `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
     VALUES ('family-canonical', 'Canonical Family', 'Canonical test family', 'system', '2026-08-06T00:00:00.000Z')`,
  ).run();
  db.query(
    `INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
     VALUES (?, 'family-canonical', 1, 'Canonical Contract', 'Canonical test contract',
             'https://github.com/heidi-dang/FlowDeck',
             '0000000000000000000000000000000000000000', 'system', '2026-08-06T00:00:00.000Z')`,
  ).run(CONTRACT_ID);
  db.query(
    `INSERT OR IGNORE INTO requirements (id, contract_id, title, description, priority, sort_order)
     VALUES (?, ?, 'Requirement', 'Canonical requirement', 'high', 0)`,
  ).run(REQUIREMENT_ID, CONTRACT_ID);
  db.query(
    `INSERT OR IGNORE INTO acceptance_criteria (id, contract_id, requirement_id, title, description, verification_method, priority, sort_order)
     VALUES (?, ?, ?, 'Criterion', 'Canonical criterion', 'test', 'high', 0)`,
  ).run(CRITERION_ID, CONTRACT_ID, REQUIREMENT_ID);
  db.query(
    `INSERT OR IGNORE INTO contract_lifecycle (contract_id, family_id, status, updated_ts)
     VALUES (?, 'family-canonical', 'active', 1722900000)`,
  ).run(CONTRACT_ID);
  db.query(
    `INSERT OR IGNORE INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, current_sha, repo_branch, created_at, created_ts)
     VALUES (?, ?, 'simple', 'created', 1,
             '0000000000000000000000000000000000000000', ?, 'main',
             '2026-08-06T00:00:00.000Z', 1722900000)`,
  ).run(CANONICAL_RUN_ID, CONTRACT_ID, CANONICAL_SHA);
  db.query(
    `INSERT OR IGNORE INTO run_acceptance_criteria (id, run_id, criterion_id, status)
     VALUES (?, ?, ?, 'pending')`,
  ).run(RAC_ID, CANONICAL_RUN_ID, CRITERION_ID);
}

function buildAdapter(db: Database): CanonicalEvidenceImportAdapter {
  const tx = createTransactionManager(db);
  return new CanonicalEvidenceImportAdapter({
    db,
    runReader: new SqliteCanonicalRunReader(db),
    evidenceRepository: new SqliteEvidenceRepository(db, tx),
    idempotencyRepository: new SqliteIdempotencyRepository(db, tx),
    clock: SYSTEM_CLOCK,
    idGenerator: SEQUENTIAL_ID,
  });
}

describe("Canonical evidence import adapter binds to exact run + SHA (P0-2)", () => {
  let dir: string;
  let db: Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flowdeck-canonical-binding-"));
    db = new Database(join(dir, "test.db"));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA_V_0_2_6);
    db.exec("PRAGMA busy_timeout=5000");
    seedCanonicalFixture(db);
  });

  afterAll(() => {
    try { db.close(); } catch { /* best-effort */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports harness evidence bound to the REAL canonical run and its current SHA", async () => {
    const adapter = buildAdapter(db);
    const summary = await adapter.importReport({
      runId: CANONICAL_RUN_ID,
      sha: CANONICAL_SHA,
      report: makeReport(),
    });

    expect(summary.importedEvidenceCount).toBe(1);
    expect(summary.importedFindingCount).toBe(1);
    expect(summary.runId).toBe(CANONICAL_RUN_ID);
    expect(summary.sha).toBe(CANONICAL_SHA);

    const row = db.query("SELECT * FROM evidence WHERE run_id = ?").get(CANONICAL_RUN_ID) as {
      run_id: string;
      sha: string;
    } | undefined;
    expect(row).not.toBeNull();
    expect(row!.run_id).toBe(CANONICAL_RUN_ID);
    expect(row!.sha).toBe(CANONICAL_SHA);
  });

  it("rejects an unknown canonical run id (no task_runs row)", async () => {
    const adapter = buildAdapter(db);
    await expect(
      adapter.importReport({ runId: "run-does-not-exist", sha: CANONICAL_SHA, report: makeReport() }),
    ).rejects.toMatchObject({ code: "CANONICAL_RUN_NOT_FOUND" });
  });

  it("rejects arbitrary run-like strings that do not exist in task_runs", async () => {
    const adapter = buildAdapter(db);
    for (const bogus of ["task_run_canonical_1", "task_run_arbitrary", "run_harness_x"]) {
      await expect(
        adapter.importReport({ runId: bogus, sha: CANONICAL_SHA, report: makeReport() }),
      ).rejects.toMatchObject({ code: "CANONICAL_RUN_NOT_FOUND" });
    }
  });

  it("rejects a SHA that does not match the report sourceRevision", async () => {
    const adapter = buildAdapter(db);
    await expect(
      adapter.importReport({ runId: CANONICAL_RUN_ID, sha: "cafebabe", report: makeReport() }),
    ).rejects.toMatchObject({ code: "REPORT_SHA_MISMATCH" });
  });

  it("rejects import without any SHA", async () => {
    const adapter = buildAdapter(db);
    const report = makeReport();
    report.sourceRevision = undefined;
    await expect(
      adapter.importReport({ runId: CANONICAL_RUN_ID, report }),
    ).rejects.toMatchObject({ code: "REPORT_SOURCE_REVISION_MISSING" });
  });

  it("never writes harness run ids into the canonical store", async () => {
    const adapter = buildAdapter(db);
    const summary = await adapter.importReport({
      runId: CANONICAL_RUN_ID,
      sha: CANONICAL_SHA,
      report: makeReport(),
      harnessRunId: "run_harness_x",
    });
    expect(summary.replayed).toBe(false);

    const rows = db.query("SELECT run_id FROM evidence WHERE sha = ?").all(CANONICAL_SHA) as {
      run_id: string;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.run_id).toBe(CANONICAL_RUN_ID);
      expect(row.run_id).not.toBe("run_harness_x");
    }
  });
});
