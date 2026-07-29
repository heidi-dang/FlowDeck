import { describe, it, expect } from 'bun:test';
import { runContractSuite } from './compliance-reporter';

export function runApprovalRepositoryContract(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`ApprovalRepository Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('ApprovalRepository', implName, sha, 'v0.2.6', factory, 
        ['saveApproval', 'getApproval', 'listPendingApprovals'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('ApprovalRepository');
    });
  });
}

export function runOverrideRepositoryContract(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`OverrideRepository Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('OverrideRepository', implName, sha, 'v0.2.6', factory, 
        ['saveOverride', 'getOverride', 'listActiveOverrides'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('OverrideRepository');
    });
  });
}

export function runCompletionRepositoryContract(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`CompletionRepository Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('CompletionRepository', implName, sha, 'v0.2.6', factory, 
        ['saveCompletion', 'getCompletion', 'listCompletionsByTaskRun'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('CompletionRepository');
    });
  });
}

export function runIdempotencyRepositoryContract(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`IdempotencyRepository Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('IdempotencyRepository', implName, sha, 'v0.2.6', factory, 
        ['saveReservation', 'getReservation', 'deleteReservation'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('IdempotencyRepository');
    });
  });
}

export function runOutboxRepositoryContract(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`OutboxRepository Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('OutboxRepository', implName, sha, 'v0.2.6', factory, 
        ['saveMessage', 'getUnpublishedMessages', 'markAsPublished'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('OutboxRepository');
    });
  });
}

export function runUnitOfWorkCompliance(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`UnitOfWork Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('UnitOfWork', implName, sha, 'v0.2.6', factory, 
        ['begin', 'commit', 'rollback'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('UnitOfWork');
    });
  });
}

export function runRuntimeStateMachineCompliance(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`RuntimeStateMachine Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('RuntimeStateMachine', implName, sha, 'v0.2.6', factory, 
        ['transition', 'canTransition'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('RuntimeStateMachine');
    });
  });
}

export function runReplayCompliance(factory: () => any, implName: string = 'Unknown', sha: string = 'HEAD') {
  describe(`Replay Compliance (${implName})`, () => {
    it('validates semantics', async () => {
      const result = await runContractSuite('Replay', implName, sha, 'v0.2.6', factory, 
        ['replayFromStart', 'replayFromSequence'], 
        async (repo, record) => {}
      );
      expect(result.port).toBe('Replay');
    });
  });
}
