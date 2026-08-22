import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { join } from 'path';

const runnerPath = join(process.cwd(), 'scripts', 'orchestration', 'run-integration-matrix.mjs');

describe('Integration Runner CLI (Negative)', () => {
  it('rejects missing or invalid profile', () => {
    try {
      execFileSync(process.execPath, [runnerPath, '--profile', 'non_existent_profile'], { stdio: 'pipe' });
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.stderr.toString()).toContain('Invalid profile');
    }
  });

  it('rejects short SHA or invalid SHAs internally', () => {
    let failed = false;
    try {
      execFileSync(process.execPath, [runnerPath, '--target', 'short'], { stdio: 'pipe', timeout: 3000 });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }, 10000);
});

describe('Artifact Validator (Negative)', () => {
  it('runs artifact validator and asserts exit code', () => {
    const validatorPath = join(process.cwd(), 'scripts', 'orchestration', 'validate-artifacts.mjs');
    const out = execFileSync(process.execPath, [validatorPath], { encoding: 'utf-8', stdio: 'pipe' });
    expect(typeof out).toBe('string');
  });
});
