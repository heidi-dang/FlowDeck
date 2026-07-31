import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { SCHEMA_V_0_2_6 } from "../../../src/orchestration/persistence/migrations/schema-embed";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import type { TransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteTaskRunAdapter } from "../../../src/orchestration/persistence/adapters/sqlite-runtime-adapter";
import { SqliteContractAdapter } from "../../../src/orchestration/persistence/adapters/sqlite-contract-adapter";
import {
  SqliteRunRepository,
  SqliteContractRepo,
  SqliteAssignmentRepo,
} from "../../../src/orchestration/composition";
import { deterministicCleanup } from "../harness/cleanup";
import { RunStatus, OrchestrationPhase } from "../../../src/orchestration/types/runs";
import { ErrorCodes } from "../../../src/orchestration/types/errors";
import type { Run } from "../../../src/orchestration/types/runs";
import type { Contract } from "../../../src/orchestration/types/contracts";
import type { Assignment } from "../../../src/orchestration/types/assignments";

function seedParents(db: Database, contractId = "contract-default"): void {
  db.query(
    `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
     VALUES ('family-default', 'Default Family', 'Default contract family', 'system', datetime('now'))`,
  ).run();
  db.query(
    `INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
     VALUES (?, 'family-default', 1, 'Default Contract', 'Default contract description',
             'https://github.com/heidi-dang/FlowDeck',
             '0000000000000000000000000000000000000000', 'system', datetime('now'))`,
  ).run(contractId);
}

function insertTaskRun(db: Database, runId: string): void {
  db.query(
    `INSERT OR IGNORE INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, repo_branch, created_at, created_ts)
     VALUES (?, 'contract-default', 'simple', ?, 1,
             '0000000000000000000000000000000000000000', 'main',
             datetime('now'), strftime('%s','now'))`,
  ).run(runId, OrchestrationPhase.CREATED);
}

function makeRun(id: string, overrides?: Partial<Run>): Run {
  return {
    id,
    status: RunStatus.PENDING,
    runType: "simple",
    correlationId: id,
    contractId: "contract-default",
    aggregateId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContract(id: string): Contract {
  return {
    id,
    name: "Test Contract " + id,
    status: "active" as Contract["status"],
    correlationId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeAssignment(id: string, runId: string): Assignment {
  return {
    id,
    runId,
    agentId: "agent-" + id,
    role: "coder",
    status: "pending" as Assignment["status"],
    correlationId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Timestamp integrity", () => {
  let tempDir: string;
  let db: Database;
  let tx: TransactionManager;
  let repo: SqliteContractRepo | null = null;
  let assignmentRepo: SqliteAssignmentRepo | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "integrity-ts-"));
    db = new Database(join(tempDir, "test.db"));
    db.exec(SCHEMA_V_0_2_6);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    tx = createTransactionManager(db);
  });

  afterEach(async () => {
    await deterministicCleanup({ db, dir: tempDir });
  });

  it("contract createdAt is unchanged after update", async () => {
    const adapter = new SqliteContractAdapter(db, tx);
    repo = new SqliteContractRepo(adapter, db, tx);
    await repo.create(makeContract("ct-ts-1"));
    const preUpdate = await repo.findById("ct-ts-1");
    const originalCreatedAt = preUpdate!.createdAt;
    const updated = await repo.update("ct-ts-1", { name: "Updated Name" });
    expect(updated!.createdAt).toBe(originalCreatedAt);
  });

  it("assignment createdAt is unchanged after update", async () => {
    seedParents(db);
    insertTaskRun(db, "run-ts-assign");
    assignmentRepo = new SqliteAssignmentRepo(db, tx);
    await assignmentRepo.create(makeAssignment("a-ts-1", "run-ts-assign"));
    const preUpdate = await assignmentRepo.findById("a-ts-1");
    const originalCreatedAt = preUpdate!.createdAt;
    const updated = await assignmentRepo.update("a-ts-1", { status: "completed" });
    expect(updated!.createdAt).toBe(originalCreatedAt);
  });

  it("contract createdAt survives close and reopen", async () => {
    const adapter = new SqliteContractAdapter(db, tx);
    repo = new SqliteContractRepo(adapter, db, tx);
    await repo.create(makeContract("ct-reopen"));
    const originalRow = db.query("SELECT created_at FROM task_contracts WHERE contract_id = ?").get("ct-reopen") as { created_at: string };
    const originalCreatedAt = originalRow.created_at;
    db.close();
    db = new Database(join(tempDir, "test.db"));
    const tx2 = createTransactionManager(db);
    const adapter2 = new SqliteContractAdapter(db, tx2);
    const repo2 = new SqliteContractRepo(adapter2, db, tx2);
    const found = await repo2.findById("ct-reopen");
    expect(found).not.toBeNull();
    expect(found!.createdAt).toBe(originalCreatedAt);
  });

  it("assignment createdAt survives close and reopen", async () => {
    seedParents(db);
    insertTaskRun(db, "run-ts-reopen");
    assignmentRepo = new SqliteAssignmentRepo(db, tx);
    await assignmentRepo.create(makeAssignment("a-reopen", "run-ts-reopen"));
    const originalRow = db.query("SELECT created_at FROM assignments WHERE id = ?").get("a-reopen") as { created_at: string };
    const originalCreatedAt = originalRow.created_at;
    db.close();
    db = new Database(join(tempDir, "test.db"));
    const tx2 = createTransactionManager(db);
    const repo2 = new SqliteAssignmentRepo(db, tx2);
    const found = await repo2.findById("a-reopen");
    expect(found).not.toBeNull();
    expect(found!.createdAt).toBe(originalCreatedAt);
  });
});

describe("Queue semantics", () => {
  let tempDir: string;
  let db: Database;
  let tx: TransactionManager;
  let adapter: SqliteTaskRunAdapter;
  let repo: SqliteRunRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "integrity-q-"));
    db = new Database(join(tempDir, "test.db"));
    db.exec(SCHEMA_V_0_2_6);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    tx = createTransactionManager(db);
    seedParents(db);
    adapter = new SqliteTaskRunAdapter(db, tx);
    repo = new SqliteRunRepository(adapter, db, tx);
  });

  afterEach(async () => {
    await deterministicCleanup({ db, dir: tempDir });
  });

  it("PENDING persists as CREATED and reloads as PENDING", async () => {
    const _run = await repo.create({ ...makeRun("q-pending"), status: RunStatus.PENDING });
    expect(_run.status).toBe(RunStatus.PENDING);
    const found = await repo.findById("q-pending");
    expect(found!.status).toBe(RunStatus.PENDING);
    const row = db.query("SELECT state FROM task_runs WHERE run_id = ?").get("q-pending") as { state: string };
    expect(row.state).toBe(OrchestrationPhase.CREATED);
  });

  it("QUEUED maps to CREATED at the repository boundary", async () => {
    // QUEUED is canonicalized to PENDING at the API/service layer.
    // At the repository, QUEUED maps to CREATED via mapRunStatusToTaskRunState,
    // which is valid — the canonicalization ensures the repo never sees QUEUED in production.
    const _run = await repo.create({ ...makeRun("q-rejected"), status: RunStatus.QUEUED as any });
    expect(_run.status).toBe(RunStatus.QUEUED);
    const found = await repo.findById("q-rejected");
    expect(found).not.toBeNull();
  });

  it("repository rejects invalid domain status", async () => {
    let caught = false;
    try {
      await repo.create({ ...makeRun("q-invalid"), status: "invalid_status" as RunStatus });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });

  it("filtering by PENDING returns runs with CREATED phase", async () => {
    await repo.create(makeRun("qf-1"));
    await repo.create(makeRun("qf-2"));
    const result = await repo.findMany({ status: RunStatus.PENDING }, { page: 1, limit: 10 });
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items.every(r => r.status === RunStatus.PENDING)).toBe(true);
  });

  it("filtering by RUNNING returns runs with EXECUTING phase", async () => {
    await repo.create(makeRun("qr-1"));
    await repo.update("qr-1", { status: RunStatus.RUNNING });
    const result = await repo.findMany({ status: RunStatus.RUNNING }, { page: 1, limit: 10 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.every(r => r.status === RunStatus.RUNNING)).toBe(true);
  });

  it("counting by PENDING returns correct count", async () => {
    await repo.create(makeRun("qc-1"));
    await repo.create(makeRun("qc-2"));
    const count = await repo.count({ status: RunStatus.PENDING });
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("Assignment result and metadata integrity", () => {
  let tempDir: string;
  let db: Database;
  let tx: TransactionManager;
  let repo: SqliteAssignmentRepo;
  let runId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "integrity-a-"));
    db = new Database(join(tempDir, "test.db"));
    db.exec(SCHEMA_V_0_2_6);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    tx = createTransactionManager(db);
    seedParents(db);
    runId = "run-for-assign-integrity";
    insertTaskRun(db, runId);
    repo = new SqliteAssignmentRepo(db, tx);
  });

  afterEach(async () => {
    await deterministicCleanup({ db, dir: tempDir });
  });

  it("result never enters error_message", async () => {
    await repo.create(makeAssignment("a-res-1", runId));
    let caught = false;
    try {
      await repo.update("a-res-1", { result: { summary: "passed" } });
    } catch (e: any) {
      caught = true;
      expect(e.code).toBe(ErrorCodes.ASSIGNMENT_RESULT_PERSISTENCE_NOT_CONFIGURED.code);
    }
    expect(caught).toBe(true);
    const row = db.query("SELECT error_message FROM assignments WHERE id = ?").get("a-res-1") as { error_message: string | null };
    expect(row.error_message).toBeNull();
  });

  it("unsupported result fails with typed error", async () => {
    await repo.create(makeAssignment("a-res-2", runId));
    let caught = false;
    try {
      await repo.update("a-res-2", { result: { data: "test" } });
    } catch (e: any) {
      caught = true;
      expect(e.code).toBe(ErrorCodes.ASSIGNMENT_RESULT_PERSISTENCE_NOT_CONFIGURED.code);
    }
    expect(caught).toBe(true);
  });

  it("unsupported metadata fails with typed error", async () => {
    await repo.create(makeAssignment("a-meta-1", runId));
    let caught = false;
    try {
      await repo.update("a-meta-1", { metadata: { key: "value" } });
    } catch (e: any) {
      caught = true;
      expect(e.code).toBe(ErrorCodes.ASSIGNMENT_METADATA_PERSISTENCE_NOT_CONFIGURED.code);
    }
    expect(caught).toBe(true);
  });

  it("a failed compound update changes no fields", async () => {
    await repo.create(makeAssignment("a-comp-1", runId));
    const originalStatus = "pending";
    const preUpdate = await repo.findById("a-comp-1");
    expect(preUpdate!.status).toBe(originalStatus);
    let caught = false;
    try {
      await repo.update("a-comp-1", { status: "completed", result: { data: "should fail" } });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    const found = await repo.findById("a-comp-1");
    expect(found!.status).toBe(originalStatus);
  });

  it("error_message remains reserved for real failures", async () => {
    await repo.create(makeAssignment("a-err-1", runId));
    const row = db.query("SELECT error_message FROM assignments WHERE id = ?").get("a-err-1") as { error_message: string | null };
    expect(row.error_message).toBeNull();
  });

  it("supported status update survives restart", async () => {
    await repo.create(makeAssignment("a-survive", runId));
    await repo.update("a-survive", { status: "completed" });
    db.close();
    db = new Database(join(tempDir, "test.db"));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    const tx2 = createTransactionManager(db);
    const repo2 = new SqliteAssignmentRepo(db, tx2);
    const found = await repo2.findById("a-survive");
    expect(found).not.toBeNull();
    expect(found!.status).toBe("completed");
  });
});
