import { describe, it, expect } from 'bun:test';
import { runContractSuite } from '../compliance/contracts/compliance-reporter';
import { ContractFamily } from '../../../../src/orchestration/contracts/domain/contract';

describe('Negative Mutation Proof', () => {
  it('fails when a repository is missing a required method', async () => {
    const defectiveFactory = () => {
      return {
        saveFamily: async () => {},
        getFamily: async () => undefined,
        listFamilies: async () => []
        // Missing deleteFamily
      } as any;
    };

    const result = await runContractSuite(
      'ContractRepository',
      'DefectiveImpl',
      'HEAD',
      'v0.2.6',
      defectiveFactory,
      ['saveFamily', 'getFamily', 'listFamilies', 'deleteFamily'],
      async () => {}
    );

    expect(result.status).toBe('non_compliant');
    expect(result.missingMethods).toContain('deleteFamily');
  });

  it('fails when method returns wrong entity or fails semantic check', async () => {
    const defectiveFactory = () => {
      return {
        saveFamily: async () => {},
        getFamily: async () => new ContractFamily({ id: 'wrong', name: 'Wrong', description: '', versions: [], createdAt: new Date() }),
        listFamilies: async () => [],
        deleteFamily: async () => {}
      } as any;
    };

    const result = await runContractSuite(
      'ContractRepository',
      'DefectiveImpl',
      'HEAD',
      'v0.2.6',
      defectiveFactory,
      ['saveFamily', 'getFamily', 'listFamilies', 'deleteFamily'],
      async (repo, recordFailure) => {
        const family = await repo.getFamily('fam-1');
        if (family?.name !== 'Test Family') {
          recordFailure('getFamily failed to return saved family');
        }
      }
    );

    expect(result.status).toBe('non_compliant');
    expect(result.semanticFailures).toBeDefined();
    expect(result.semanticFailures).toContain('getFamily failed to return saved family');
  });
});
