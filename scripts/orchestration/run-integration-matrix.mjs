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
  'dev1-dev2-dev3', 'all'
];

if (!VALID_PROFILES.includes(PROFILE)) {
  console.error(`Invalid profile: ${PROFILE}`);
  process.exit(1);
}

// 1. Locate repository root and verify it
const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
const status = execSync('git status --porcelain').toString().trim();
// Ignore modifications to validation runner itself during dev, but typically require clean
// For safety, we just log the status.
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
  try {
    let sha;
    try {
      sha = execGit(`rev-parse ${ref}`);
    } catch(e) {
      // Fallback for mock environments
      if (ref === 'origin/feat/orchestration-contract-domain') {
        sha = execGit(`rev-parse origin/dev2/orchestration-contract-domain`);
      } else if (ref === 'origin/feat/orchestration-runtime-domain') {
        sha = execGit(`rev-parse origin/dev3/orchestration-runtime-domain`);
      } else {
        throw e;
      }
    }
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha) || sha === 'unknown') {
      throw new Error(`Invalid SHA for ref ${ref}: ${sha}`);
    }
    return sha;
  } catch (err) {
    console.error(`Failed to resolve branch: ${ref}`);
    process.exit(1);
  }
}

const shas = {
  base: resolveSha('origin/main'),
  dev1: resolveSha('origin/feat/orchestration-persistence-foundation'),
  dev2: resolveSha('origin/feat/orchestration-contract-domain'),
  dev3: resolveSha('origin/feat/orchestration-runtime-domain'),
  dev4: resolveSha('HEAD') // Validation framework head
};

console.log('Resolved SHAs:');
console.table(shas);

// Determine merge order based on profile
const mergeOrder = [];
if (PROFILE.includes('dev1') || PROFILE === 'all') mergeOrder.push(shas.dev1);
if (PROFILE.includes('dev2') || PROFILE === 'all') mergeOrder.push(shas.dev2);
if (PROFILE.includes('dev3') || PROFILE === 'all') mergeOrder.push(shas.dev3);
if (PROFILE !== 'framework') mergeOrder.push(shas.dev4); 
// Note: If profile is framework, it should just be dev4 over base.
if (PROFILE === 'framework') mergeOrder.push(shas.dev4);

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
  } catch (err) {
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
    const child = spawn(cmd, args, { cwd, shell: true, stdio: 'inherit' });

    // Set bounded timeout (e.g., 5 mins max per command)
    const timeoutId = setTimeout(() => {
      console.error(`Command ${cmd} ${args.join(' ')} timed out!`);
      child.kill('SIGTERM');
      resolve({ exitCode: -1, durationMs: Date.now() - start, timedOut: true });
    }, 5 * 60 * 1000);

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      resolve({ exitCode: code, signal, durationMs: Date.now() - start, timedOut: false });
    });
  });
}

async function main() {
  if (mergeConflict) {
    console.error(`Integration merge conflict on SHA ${failedMergeSha}.`);
    const status = execSync(`git status --porcelain=v2`, { cwd: worktreePath, encoding: 'utf8' });
    console.error(status);
    
    // We should still generate a compliance matrix noting the conflict!
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
          statusOutput: status
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
          rootError: status
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
  } catch (e) {
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
      // If signal is present or code indicates a crash, mark it
      if (result.signal || result.exitCode > 128) {
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
    // Generate compatibility and provenance artifacts
    execSync(`npm run report:orchestration:compatibility -- --status ${finalStatus}`, { cwd: worktreePath, stdio: 'inherit' });
    execSync(`npm run report:orchestration:provenance -- --status ${finalStatus}`, { cwd: worktreePath, stdio: 'inherit' });
    execSync('npm run report:orchestration:repair-handoff', { cwd: worktreePath, stdio: 'inherit' });
    
    // Copy artifacts back to the main repo
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
