import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import Database from 'better-sqlite3';
import { createTransactionManager, type TransactionManager } from '../../../src/orchestration/persistence/transaction-manager';
import { EventsRepository } from '../../../src/orchestration/persistence/repositories/event';
import { TaskRunsRepository } from '../../../src/orchestration/persistence/repositories/task-run';
import { SqliteContractAdapter } from '../../../src/orchestration/persistence/adapters/sqlite-contract-adapter';
import { runEventStoreContract } from '../compliance/contracts/event-store-contract';
import { runContractRepositoryContract } from '../compliance/contracts/contract-repository-contract';
import { runEvidenceRepositoryContract } from '../compliance/contracts/evidence-repository-contract';
import { runVerificationRepositoryContract } from '../compliance/contracts/verification-repository-contract';
import { SCHEMA_V_0_2_6 } from '../../../src/orchestration/persistence/migrations/schema-embed';
import { SqliteTestHarness } from '../harness/sqlite-harness';
import { writeComplianceArtifact } from '../compliance/contracts/compliance-reporter';
import { afterAll } from 'bun:test';
import {
  runApprovalRepositoryContract,
  runOverrideRepositoryContract,
  runCompletionRepositoryContract,
  runIdempotencyRepositoryContract,
  runOutboxRepositoryContract,
  runUnitOfWorkCompliance,
  runRuntimeStateMachineCompliance,
  runReplayCompliance
} from '../compliance/contracts/additional-contracts';

describe('SQLite Production Integration Tests', () => {
  let db: Database.Database;
  let txManager: TransactionManager;
  let harness: SqliteTestHarness;

  beforeEach(() => {
    harness = new SqliteTestHarness();
    db = (harness.db as any);
    // Use schema-embed to initialize tables
    db.exec(SCHEMA_V_0_2_6);
    txManager = createTransactionManager(db);
  });

  afterEach(() => {
    harness.close();
  });

  afterAll(() => {
    if (process.env.GENERATE_COMPLIANCE_ARTIFACT === 'true') {
      const artifactPath = process.env.ARTIFACT_PATH || 'dev1-dev2-compatibility.json';
      writeComplianceArtifact(
        artifactPath,
        process.env.DEV1_SHA || 'unknown',
        process.env.DEV2_SHA || 'unknown',
        process.env.DEV4_SHA || 'unknown'
      );
    }
  });

  describe('EventsRepository', () => {
    runEventStoreContract(() => new EventsRepository(db, txManager) as any, 'EventsRepository', process.env.DEV1_SHA);
  });

  describe('SqliteContractAdapter (ContractRepository)', () => {
    runContractRepositoryContract(() => new SqliteContractAdapter(db, txManager) as any, 'SqliteContractAdapter', process.env.DEV1_SHA);
  });
  
  describe('Missing Implementations', () => {
    runEvidenceRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runVerificationRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runApprovalRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runOverrideRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runCompletionRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runIdempotencyRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runOutboxRepositoryContract(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runUnitOfWorkCompliance(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runRuntimeStateMachineCompliance(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
    runReplayCompliance(() => ({} as any), 'Missing Implementation', process.env.DEV1_SHA);
  });

  describe('TaskRunsRepository', () => {
    it('creates and finds by ID', () => {
      const repo = new TaskRunsRepository(db, txManager);
      const run = repo.create({
        runId: 'run-1', contractId: 'c-1', strategy: 'simple', baselineSha: 'sha1', repoBranch: 'main'
      });
      expect(run.state).toBe('created');
      const found = repo.findById('run-1');
      expect(found?.runId).toBe('run-1');
    });
  });
});
