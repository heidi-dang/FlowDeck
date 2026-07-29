import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRepo = mkdtempSync(join(tmpdir(), 'synthetic-runner-'));

try {
  // 1. Setup synthetic repo
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo });
  execSync('git config user.name "Test"', { cwd: tempRepo });
  
  const pkg = {
    scripts: {
      "typecheck": "echo 'passing'",
      "test:orchestration:port-discovery": "echo 'passing'",
      "test:orchestration:compliance": "node -e \"process.exit(1)\"", // normal failing command
      "test:orchestration:replay": "node -e \"process.kill(process.pid, 'SIGSEGV')\"", // signal-terminated command
      "test:orchestration:concurrency": "node -e \"console.error('panic(main thread): NAPI FATAL ERROR'); process.exit(139)\"", // panic string
      "test:orchestration:fault-injection": "echo 'passing'",
      "report:orchestration:compatibility": "echo 'artifacts generated'",
      "report:orchestration:provenance": "echo 'artifacts generated'",
      "report:orchestration:repair-handoff": "echo 'artifacts generated'"
    }
  };
  
  writeFileSync(join(tempRepo, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(tempRepo, 'package-lock.json'), JSON.stringify({lockfileVersion: 3}), 'utf8');
  execSync('git add . && git commit -m "base"', { cwd: tempRepo });
  execSync('git branch -m main', { cwd: tempRepo });
  execSync('git rev-parse HEAD', { cwd: tempRepo }).toString().trim();
  
  execSync('git checkout -b feat/orchestration-persistence-foundation', { cwd: tempRepo });
  execSync('git checkout -b dev2/orchestration-contract-domain', { cwd: tempRepo });
  execSync('git checkout -b dev3/orchestration-runtime-domain', { cwd: tempRepo });
  execSync('git checkout main', { cwd: tempRepo });

  // 2. We need to run run-integration-matrix.mjs. But run-integration-matrix.mjs has hardcoded `repoRoot` using `git rev-parse --show-toplevel`.
  const originalScriptPath = join(process.cwd(), 'scripts', 'orchestration', 'run-integration-matrix.mjs');
  mkdirSync(join(tempRepo, 'scripts', 'orchestration'), { recursive: true });
  execSync(`xcopy "${originalScriptPath}" "scripts\\orchestration\\" /Y`, { cwd: tempRepo, shell: 'cmd.exe' });
  
  // Wait, run-integration-matrix resolves branches using `origin/`. We don't have an origin.
  // We can patch the script in memory to use local branches for this test.
  let scriptContent = readFileSync(join(tempRepo, 'scripts/orchestration/run-integration-matrix.mjs'), 'utf8');
  scriptContent = scriptContent.replace(/origin\//g, '');
  scriptContent = scriptContent.replace("execGit('fetch origin --prune');", "// fetch removed");
  // Don't error out on npm ci since there's no real lockfile that is complete
  scriptContent = scriptContent.replace("execSync('npm ci'", "execSync('npm install'");
  writeFileSync(join(tempRepo, 'scripts/orchestration/run-integration-matrix.mjs'), scriptContent);

  console.log('Running synthetic integration...');
  try {
    execSync(`node scripts/orchestration/run-integration-matrix.mjs --profile all`, { cwd: tempRepo, stdio: 'pipe' });
  } catch (err) {
    const stdout = err.stdout.toString();
    const stderr = err.stderr.toString();
    console.log('--- STDOUT ---');
    console.log(stdout);
    console.log('--- STDERR ---');
    console.log(stderr);
    
    // Assertions
    if (!stdout.includes('Typecheck passed')) throw new Error('Did not run passing command');
    if (!stderr.includes('Compliance failed with exit code 1')) throw new Error('Did not handle normal failing command');
    if (!stderr.includes('Replay failed') && !stderr.includes('signal SIGSEGV') && !stderr.includes('exit code 3221225477')) {
      throw new Error('Did not handle signal-terminated command: ' + stderr);
    }
    if (!stdout.includes('Generating artifacts with status failed_by_runtime_crash')) throw new Error('Did not set status correctly');
    console.log('Synthetic runner test passed!');
  }

} finally {
  rmSync(tempRepo, { recursive: true, force: true });
}
