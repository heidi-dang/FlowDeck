import { describe, it, expect } from 'bun:test';
import type { EvidenceRepository } from '../../../../src/orchestration/evidence/ports/evidence-repository';
import type { Evidence } from '../../../../src/orchestration/evidence/domain/evidence';
import { runContractSuite } from './compliance-reporter';

export function runEvidenceRepositoryContract(
  factory: () => EvidenceRepository,
  implementationName: string = 'Unknown',
  sha: string = 'HEAD'
) {
  describe(`EvidenceRepository Compliance (${implementationName})`, () => {
    it('validates against Dev 2 exact port methods and semantics', async () => {
      const result = await runContractSuite<EvidenceRepository>(
        'EvidenceRepository',
        implementationName,
        sha,
        'v0.2.6',
        factory,
        ['saveEvidence', 'getEvidence', 'listEvidenceByTaskRun'],
        async (repo, recordFailure) => {
          try {
            const ev: Evidence = {
              id: 'ev-1',
              taskRunId: 'run-1',
              type: 'test-result', payload: {}, collectedAt: new Date(), isVerified: false, 
              verify: () => ({} as any)
            };
            await repo.saveEvidence(ev);
            const retrieved = await repo.getEvidence('ev-1');
            if (retrieved?.type !== 'test-result') recordFailure('saveEvidence failed');

            const all = await repo.listEvidenceByTaskRun('run-1');
            if (all.length === 0) recordFailure('listEvidenceByTaskRun failed');
          } catch (e: any) {
            recordFailure(e.message);
          }
        }
      );
      expect(result.port).toBe('EvidenceRepository');
    });
  });
}
