import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROFILE = process.argv.includes('--profile') 
  ? process.argv[process.argv.indexOf('--profile') + 1] 
  : 'all';

const VALID_PROFILES = [
  'framework', 'dev1', 'dev2', 'dev3', 
  'dev1-dev2', 'dev1-dev3', 'dev2-dev3', 
  'dev1-dev2-dev3', 'all', 'conflict-negative'
];

if (!VALID_PROFILES.includes(PROFILE)) {
  console.error(`Invalid profile: ${PROFILE}`);
  process.exit(1);
}

// 1. Locate repository root and verify it
const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
const status = execSync('git status --porcelain').toString().trim();
if (status) {
  console.log('Warning: Current worktree is not clean. Integration worktree will be separate.');
}

function execGit(command, options = {}) {
  try {
    return execSync(`git ${command}`, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
  } catch (err) {
    if (err.stdout) console.log(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    throw new Error(`Git command failed: git ${command}`);
  }
}

// 2. Fetch and resolve exact SHAs
console.log('Fetching remote branches...');
execGit('fetch origin --prune');

function resolveSha(ref) {
  const refsToTry = [ref];
  if (ref.includes('persistence-foundation')) {
    refsToTry.push('origin/dev1/orchestration-persistence-foundation', 'origin/feat/orchestration-persistence-foundation');
  } else if (ref.includes('contract-domain')) {
    refsToTry.push('origin/dev2/orchestration-contract-domain', 'origin/feat/orchestration-contract-domain');
  } else if (ref.includes('runtime-domain')) {
    refsToTry.push('origin/dev3/orchestration-runtime-domain', 'origin/feat/orchestration-runtime-domain');
  } else if (ref.includes('final-integration')) {
    refsToTry.push('origin/feat/orchestration-final-integration');
  } else if (ref.includes('validation')) {
    refsToTry.push('origin/fix/orchestration-validation-final', 'HEAD');
  }
  
  for (const r of refsToTry) {
    try {
      const sha = execGit(`rev-parse ${r}`);
      if (sha && /^[0-9a-f]{40}$/i.test(sha) && sha !== 'unknown') {
        return sha;
      }
    } catch {}
  }
  
  console.error(`Failed to resolve branch ref: ${ref}`);
  process.exit(1);
}

const shas = {
  base: PROFILE === 'conflict-negative'
    ? resolveSha('origin/main')
    : resolveSha('origin/feat/orchestration-final-integration'),
  dev1: resolveSha('origin/dev1/orchestration-persistence-foundation'),
  dev2: resolveSha('origin/dev2/orchestration-contract-domain'),
  dev3: resolveSha('origin/dev3/orchestration-runtime-domain'),
  dev4: resolveSha('origin/fix/orchestration-validation-final')
};

console.log('Resolved SHAs for profile:', PROFILE);
console.table(shas);

// Determine merge order based on profile
const mergeOrder = [];
if (PROFILE === 'conflict-negative') {
  // Negative test fixture: merging dev1 then dev2 onto main produces the canonical merge conflict
  mergeOrder.push(shas.dev1, shas.dev2);
} else if (PROFILE === 'all' || PROFILE === 'framework') {
  // Canonical current source set: PR #47 base is already integrated with Dev 1-3.
  // Merge current validation framework HEAD onto PR #47 base.
  mergeOrder.push(shas.dev4);
} else {
  if (PROFILE.includes('dev1')) mergeOrder.push(shas.dev1);
  if (PROFILE.includes('dev2')) mergeOrder.push(shas.dev2);
  if (PROFILE.includes('dev3')) mergeOrder.push(shas.dev3);
  mergeOrder.push(shas.dev4);
}

const runId = randomUUID();
const worktreePath = join(tmpdir(), `flowdeck-orchestration-integration-${runId}`);

// 3. Create disposable worktree using git worktree add
console.log(`Creating worktree at ${worktreePath}...`);
execGit(`worktree add --detach "${worktreePath}" "${shas.base}"`);

// 4. Write ownership marker
const marker = {
  runId,
  repoRoot,
  worktreePath,
  creatorPid: process.pid,
  createdAt: new Date().toISOString(),
  profile: PROFILE,
  shas
};
writeFileSync(join(worktreePath, 'integration-marker.json'), JSON.stringify(marker, null, 2));

// 5. Merge branches deterministically
let mergeConflict = false;
let failedMergeSha = null;

for (const sha of mergeOrder) {
  console.log(`Merging ${sha}...`);
  try {
    execSync(`git merge --no-commit --no-ff "${sha}"`, { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    console.error(`Merge conflict or failure when merging ${sha}`);
    mergeConflict = true;
    failedMergeSha = sha;
    break;
  }
}

function cleanupWorktree() {
  console.log(`Cleaning up worktree at ${worktreePath}...`);
  try {
    execGit(`worktree remove --force "${worktreePath}"`);
    execGit(`worktree prune`);
  } catch (err) {
    console.error('Failed to cleanly remove git worktree.', err.message);
    if (existsSync(join(worktreePath, 'integration-marker.json'))) {
      const storedMarker = JSON.parse(readFileSync(join(worktreePath, 'integration-marker.json'), 'utf8'));
      if (storedMarker.runId === runId) {
        console.log('Ownership marker verified. Attempting filesystem fallback deletion...');
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } else {
      console.error('Worktree marker missing or invalid. Refusing to delete path:', worktreePath);
    }
  }
}

async function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd, shell: true, stdio: ['inherit', 'inherit', 'pipe'] });

    const timeoutId = setTimeout(() => {
      console.error(`Command ${cmd} ${args.join(' ')} timed out!`);
      child.kill('SIGTERM');
      resolve({ exitCode: -1, durationMs: Date.now() - start, timedOut: true });
    }, 5 * 60 * 1000);

    let capturedStderr = '';
    child.stderr.on('data', (data) => {
      capturedStderr += data.toString();
      process.stderr.write(data);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      resolve({ exitCode: code, signal, stderr: capturedStderr, durationMs: Date.now() - start, timedOut: false });
    });
  });
}

async function main() {
  if (mergeConflict) {
    console.error(`Integration merge conflict on SHA ${failedMergeSha}.`);
    const statusOutput = execSync(`git status --porcelain=v2`, { cwd: worktreePath, encoding: 'utf8' });
    console.error(statusOutput);
    
    try {
      const artifactsDir = join(repoRoot, 'artifacts', 'orchestration-compliance');
      if (!existsSync(artifactsDir)) execSync(`mkdir -p "${artifactsDir}"`, { shell: 'cmd.exe' });
      
      const provenance = {
        baseSha: shas.base,
        integrationDev1Sha: shas.dev1,
        integrationDev2Sha: shas.dev2,
        integrationDev3Sha: shas.dev3,
        integrationDev4Sha: shas.dev4,
        mergeOrder,
        profile: PROFILE,
        status: 'blocked_by_merge_conflict',
        failures: [{
          port: 'Integration',
          implementation: 'Merge',
          classification: 'integration_merge_conflict',
          mergeConflictSha: failedMergeSha,
          statusOutput
        }]
      };
      
      writeFileSync(join(artifactsDir, 'failure-provenance.json'), JSON.stringify(provenance, null, 2));
      
      const matrix = {
        schemaVersion: '1.0',
        metadata: { runId, profile: PROFILE, generatedAt: new Date().toISOString(), status: 'blocked_by_merge_conflict' },
        shas,
        findings: [{
          id: 'F-INT-MERGE-01',
          owner: 'Dev ' + (failedMergeSha === shas.dev1 ? '1' : failedMergeSha === shas.dev2 ? '2' : '3'),
          category: 'integration_merge_conflict',
          evidenceLevel: 'confirmed',
          canonicalPort: 'N/A',
          implementation: 'N/A',
          expectedBehavior: 'Clean merge',
          observedBehavior: 'Merge conflict',
          rootError: statusOutput
        }]
      };
      
      writeFileSync(join(artifactsDir, 'compatibility-matrix.json'), JSON.stringify(matrix, null, 2));
    } catch (e) {
      console.error('Failed to generate failure artifact manually', e);
    }
    
    cleanupWorktree();
    process.exit(1);
  }

  console.log('Merge complete. Installing dependencies...');
  try {
    execSync('npm ci', { cwd: worktreePath, stdio: 'inherit' });
  } catch {
    console.error('Failed to install dependencies in worktree.');
    cleanupWorktree();
    process.exit(1);
  }

  const testsToRun = [
    { name: 'Typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
    { name: 'Port Discovery', cmd: 'npm', args: ['run', 'test:orchestration:port-discovery'] },
    { name: 'Compliance', cmd: 'npm', args: ['run', 'test:orchestration:compliance'] },
    { name: 'Replay', cmd: 'npm', args: ['run', 'test:orchestration:replay'] },
    { name: 'Concurrency', cmd: 'npm', args: ['run', 'test:orchestration:concurrency'] },
    { name: 'Fault Injection', cmd: 'npm', args: ['run', 'test:orchestration:fault-injection'] }
  ];

  let success = true;
  let finalStatus = 'completed';

  for (const test of testsToRun) {
    console.log(`\n--- Running ${test.name} ---`);
    const result = await runCommand(test.cmd, test.args, worktreePath);
    if (result.exitCode !== 0 || result.signal) {
      console.error(`${test.name} failed with exit code ${result.exitCode} signal ${result.signal} (${result.durationMs}ms).`);
      success = false;
      
      const isCrash = (result.exitCode === null && result.signal) || 
                      (result.exitCode !== null && result.exitCode > 128) ||
                      result.stderr?.includes('FATAL ERROR') || 
                      result.stderr?.includes('panic(');

      if (isCrash) {
         finalStatus = 'failed_by_runtime_crash';
      } else if (finalStatus === 'completed') {
         finalStatus = 'failed_during_validation';
      }
    } else {
      console.log(`${test.name} passed (${result.durationMs}ms).`);
    }
  }

  console.log(`\nGenerating artifacts with status ${finalStatus}...`);
  try {
    execSync(`npm run report:orchestration:compatibility -- --status ${finalStatus}`, { cwd: worktreePath, stdio: 'inherit' });
    execSync(`npm run report:orchestration:provenance -- --status ${finalStatus}`, { cwd: worktreePath, stdio: 'inherit' });
    execSync('npm run report:orchestration:repair-handoff', { cwd: worktreePath, stdio: 'inherit' });
    
    execSync(`xcopy /s /i /y "${join(worktreePath, 'artifacts')}" "${join(repoRoot, 'artifacts')}"`, { shell: 'cmd.exe', stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to generate or copy artifacts.', err.message);
  }

  cleanupWorktree();
  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error("Unexpected unhandled error:", err);
  cleanupWorktree();
  process.exit(1);
});
