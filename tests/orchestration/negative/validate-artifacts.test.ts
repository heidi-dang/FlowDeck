import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function runValidator(artifactDir: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node scripts/orchestration/validate-artifacts.mjs`, {
      env: { ...process.env, ORCHESTRATION_ARTIFACT_DIR: artifactDir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status || 1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || ''
    };
  }
}

const VALID_SHAS = {
  base: 'cda20c3f3477639639a760df4ca038b487d50d83',
  dev1: 'db3b39d234bd3bcc522a537d181155493b7e6111',
  dev2: '47a1eca748785fe7c2a12454a594c42541e0594c',
  dev3: '4c38d6b0a2fd1d35885a2b7e3905ff220d1542b9',
  dev4: '683e9b9741b8d3f78be338b52706d1d78231c5e5'
};

function setupFixture(status: string = 'completed', overrides: { matrix?: any; provenance?: any } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-val-test-'));
  
  const matrix = overrides.matrix !== undefined ? overrides.matrix : {
    schemaVersion: '1.0',
    metadata: { runId: 'test-run-123', profile: 'all', generatedAt: new Date().toISOString(), status },
    shas: { ...VALID_SHAS },
    findings: []
  };

  const provenance = overrides.provenance !== undefined ? overrides.provenance : {
    baseSha: VALID_SHAS.base,
    integrationDev1Sha: VALID_SHAS.dev1,
    integrationDev2Sha: VALID_SHAS.dev2,
    integrationDev3Sha: VALID_SHAS.dev3,
    integrationDev4Sha: VALID_SHAS.dev4,
    profile: 'all',
    status,
    failures: status === 'blocked_by_merge_conflict' ? [{ classification: 'integration_merge_conflict', mergeConflictSha: VALID_SHAS.dev2 }] : []
  };

  if (matrix !== null) {
    writeFileSync(join(dir, 'compatibility-matrix.json'), typeof matrix === 'string' ? matrix : JSON.stringify(matrix));
  }
  if (provenance !== null) {
    writeFileSync(join(dir, 'failure-provenance.json'), typeof provenance === 'string' ? provenance : JSON.stringify(provenance));
  }

  return dir;
}

describe('Artifact Validator Gate (Fail-Closed Enforcement)', () => {
  it('passes on valid completed artifacts', () => {
    const dir = setupFixture('completed');
    try {
      const res = runValidator(dir);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Successfully verified artifact suite');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on missing directory or missing artifact file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-artifact-dir-'));
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Missing required artifact file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on malformed JSON', () => {
    const dir = setupFixture('completed', { matrix: '{ malformed json... ' });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Malformed JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on missing or invalid SHA', () => {
    const dir = setupFixture('completed', {
      matrix: {
        schemaVersion: '1.0',
        metadata: { runId: 'run-1', status: 'completed' },
        shas: { ...VALID_SHAS, base: 'short-sha' }
      }
    });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Invalid 40-hex');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on unsupported schema version', () => {
    const dir = setupFixture('completed', {
      matrix: {
        schemaVersion: '2.0',
        metadata: { runId: 'run-1', status: 'completed' },
        shas: { ...VALID_SHAS }
      }
    });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Unsupported schema version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on status mismatch between matrix and provenance', () => {
    const dir = setupFixture('completed', {
      provenance: {
        baseSha: VALID_SHAS.base,
        integrationDev1Sha: VALID_SHAS.dev1,
        integrationDev2Sha: VALID_SHAS.dev2,
        integrationDev3Sha: VALID_SHAS.dev3,
        integrationDev4Sha: VALID_SHAS.dev4,
        status: 'blocked_by_merge_conflict',
        failures: []
      }
    });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Status mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on conflict status without conflict files/details', () => {
    const dir = setupFixture('blocked_by_merge_conflict', {
      matrix: {
        schemaVersion: '1.0',
        metadata: { runId: 'run-1', status: 'blocked_by_merge_conflict' },
        shas: { ...VALID_SHAS },
        findings: [] // No merge conflict finding!
      }
    });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('no merge conflict finding is recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails non-zero on success status with failed required checks', () => {
    const dir = setupFixture('completed', {
      matrix: {
        schemaVersion: '1.0',
        metadata: { runId: 'run-1', status: 'completed' },
        shas: { ...VALID_SHAS },
        findings: [{ id: 'F-1', owner: 'Dev 1', category: 'integration_merge_conflict', evidenceLevel: 'confirmed' }]
      }
    });
    try {
      const res = runValidator(dir);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("Status 'completed' cannot contain failed required checks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
