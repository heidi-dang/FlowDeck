import { describe, it, expect } from 'bun:test';
import type { VerificationRepository } from '../../../../src/orchestration/verification/ports/verification-repository';
import type { VerificationRun } from '../../../../src/orchestration/verification/domain/verification-run';
import type { VerificationResult } from '../../../../src/orchestration/verification/domain/verification-result';
import { runContractSuite } from './compliance-reporter';

export function runVerificationRepositoryContract(
  factory: () => VerificationRepository,
  implementationName: string = 'Unknown',
  sha: string = 'HEAD'
) {
  describe(`VerificationRepository Compliance (${implementationName})`, () => {
    it('validates against Dev 2 exact port methods and semantics', async () => {
      const result = await runContractSuite<VerificationRepository>(
        'VerificationRepository',
        implementationName,
        sha,
        'v0.2.6',
        factory,
        ['saveRun', 'getRun', 'listRunsByContractVersion', 'saveResult', 'getResult', 'listResultsByRun'],
        async (repo, recordFailure) => {
          try {
            const run: VerificationRun = {
              id: 'run-1',
              contractVersionId: 'cv-1',
              status: 'pending', targetSha: 'sha', createdAt: new Date(), isComplete: false, withStatus: (s) => ({} as any),
            };
            await repo.saveRun(run);
            const retrieved = await repo.getRun('run-1');
            if (retrieved?.status !== 'pending') recordFailure('saveRun failed');

            await repo.saveRun({ id: 'r2', contractVersionId: 'cv-x', status: 'completed' as any, targetSha: 'sha', createdAt: new Date(), isComplete: false, withStatus: (s) => ({} as any) });
            const runs = await repo.listRunsByContractVersion('cv-x');
            if (runs.length === 0) recordFailure('listRunsByContractVersion failed');

            const result: VerificationResult = {
              id: 'res-1', runId: 'run-1', status: 'passed' as any, evaluatedAt: new Date()
            } as any;
            await repo.saveResult(result);
            const retrievedRes = await repo.getResult('res-1');
            if (retrievedRes?.status !== 'passed') recordFailure('saveResult failed');
          } catch (e: any) {
            recordFailure(e.message);
          }
        }
      );
      expect(result.port).toBe('VerificationRepository');
    });
  });
}
