import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const runnerPath = join(process.cwd(), 'scripts', 'orchestration', 'run-integration-matrix.mjs');

describe('Integration Runner CLI (Negative)', () => {
  it('rejects missing or invalid profile', () => {
    try {
      execSync(`node "${runnerPath}" --profile non_existent_profile`, { stdio: 'pipe' });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.stderr.toString()).toContain('Invalid profile');
    }
  });

  it('runs conflict-negative profile: exits non-zero, records merge conflict provenance/matrix, exact SHAs, and cleans worktree', () => {
    try {
      execSync(`node "${runnerPath}" --profile conflict-negative`, { stdio: 'pipe' });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.status).not.toBe(0);

      const artifactsDir = join(process.cwd(), 'artifacts', 'orchestration-compliance');
      const provPath = join(artifactsDir, 'failure-provenance.json');
      const matrixPath = join(artifactsDir, 'compatibility-matrix.json');

      expect(existsSync(provPath)).toBe(true);
      expect(existsSync(matrixPath)).toBe(true);

      const prov = JSON.parse(readFileSync(provPath, 'utf8'));
      const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));

      expect(prov.status).toBe('blocked_by_merge_conflict');
      expect(matrix.metadata.status).toBe('blocked_by_merge_conflict');
      expect(prov.failures.length).toBeGreaterThan(0);
      expect(prov.failures[0].classification).toBe('integration_merge_conflict');
      expect(prov.failures[0].mergeConflictSha).toMatch(/^[0-9a-f]{40}$/i);
      expect(prov.failures[0].statusOutput).toBeDefined();

      const valRes = execSync('node scripts/orchestration/validate-artifacts.mjs', { encoding: 'utf8' });
      expect(valRes).toContain('blocked_by_merge_conflict');
    }
  });
});
