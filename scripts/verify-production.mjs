/**
 * Production Verification Gate
 *
 * Comprehensive suite runner that validates all mandatory production test suites
 *
 * Usage:
 *   node scripts/verify-production.mjs
 *   npm run verify:production
 *
 * Exit codes:
 *   0 - All suites passed
 *   1 - One or more suites failed
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const MANDATORY_SUITES = [
  {
    name: 'Consistency',
    pattern: 'tests/consistency/',
    description: 'Repeated-run consistency tests',
  },
  {
    name: 'Trace Replay',
    pattern: 'tests/trace-replay/',
    description: 'Trace replay tests',
  },
  {
    name: 'Fault Injection',
    pattern: 'tests/fault-injection/',
    description: 'Fault injection tests',
  },
  {
    name: 'Orchestration',
    pattern: 'tests/orchestration/',
    description: 'Orchestration framework tests',
  },
  {
    name: 'Runtime Persistence',
    pattern: 'tests/runtime-persistence/',
    description: 'Restart safety, atomicity, cancellation persistence, SQLite migration tests',
  },
  {
    name: 'Phase 8 CI Production Gates',
    pattern: 'tests/phase8-ci-production-gates/',
    description: 'CI production gate and benchmark artifact verification',
  },
];

function resolveBunExecutable() {
  if (process.platform !== 'win32') return 'bun';
  const candidates = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    join(process.env.LOCALAPPDATA || '', 'bun', 'bin', 'bun.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bun.exe';
}

function runSuite(suite) {
  const bunBin = resolveBunExecutable();
  // Pattern is already a directory path like "tests/performance/"
  const basePath = join(root, suite.pattern);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Suite: ${suite.name}`);
  console.log(`Pattern: ${suite.pattern}`);
  console.log(`${'─'.repeat(60)}`);

  if (!existsSync(basePath)) {
    console.log(`✗ Suite directory not found: ${basePath}`);
    return { passed: false, skipped: false, missing: true };
  }

  const startTime = Date.now();

  try {
    const cmd = `"${bunBin}" test "${suite.pattern}"`;
    execSync(cmd, {
      cwd: root,
      stdio: 'inherit',
      encoding: 'utf-8',
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✓ ${suite.name} passed (${duration}s)`);
    return { passed: true, skipped: false, duration };
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n✗ ${suite.name} failed (${duration}s)`);
    return { passed: false, skipped: false, duration, error: err.message };
  }
}

function checkSuiteExists(suite) {
  const basePath = join(root, suite.pattern);
  return existsSync(basePath);
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('Production Verification Gate');
  console.log('='.repeat(60));

  // Step 1: Code quality & build checks
  console.log('\n[1/5] Running static analysis & build gates...');
  try {
    console.log('  -> Running lint...');
    execSync('npm run lint', { cwd: root, stdio: 'inherit' });

    console.log('  -> Running typecheck...');
    execSync('npm run typecheck', { cwd: root, stdio: 'inherit' });

    console.log('  -> Running build...');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
    console.log('✓ Static analysis and build passed');
  } catch {
    console.error('✗ Static analysis or build gate FAILED');
    process.exit(1);
  }

  // Step 2: Runtime benchmark artifact generation
  console.log('\n[2/5] Running runtime benchmark execution...');
  try {
    const bunBin = resolveBunExecutable();
    execSync(`"${bunBin}" scripts/benchmark-runtime.ts`, { cwd: root, stdio: 'inherit' });
    console.log('✓ Benchmark execution and artifact generation passed');
  } catch {
    console.error('✗ Benchmark execution FAILED');
    process.exit(1);
  }

  // Step 3: Mandatory test suites
  console.log('\n[3/5] Checking mandatory test suites:');
  for (const suite of MANDATORY_SUITES) {
    const exists = checkSuiteExists(suite);
    console.log(`  ${exists ? '✓' : '✗'} ${suite.name}`);
    console.log(`    ${suite.description}`);
    if (!exists) {
      console.log(`    (directory not found: ${suite.pattern})`);
    }
  }

  const results = [];
  let totalSuites = 0;
  let passedSuites = 0;
  let skippedSuites = 0;
  let failedSuites = 0;
  let missingSuites = 0;

  for (const suite of MANDATORY_SUITES) {
    totalSuites++;
    const result = runSuite(suite);
    results.push({ suite: suite.name, ...result });

    if (result.missing) {
      missingSuites++;
    } else if (result.skipped) {
      skippedSuites++;
    } else if (result.passed) {
      passedSuites++;
    } else {
      failedSuites++;
    }
  }

  // Step 4: Security & Package validation
  console.log('\n[4/5] Running dependency audit & package validation...');
  try {
    console.log('  -> Running npm audit...');
    execSync('npm audit --omit=dev', { cwd: root, stdio: 'inherit' });

    console.log('  -> Running npm pack dry-run...');
    execSync('npm pack --dry-run', { cwd: root, stdio: 'inherit' });
    console.log('✓ Security audit and package validation passed');
  } catch {
    console.error('✗ Dependency audit or package validation FAILED');
    process.exit(1);
  }

  // Step 5: Final Summary
  console.log('\n[5/5] Final Verification Summary');
  console.log('='.repeat(60));
  console.log(`Total suites: ${totalSuites}`);
  console.log(`Passed: ${passedSuites}`);
  console.log(`Skipped: ${skippedSuites}`);
  console.log(`Failed: ${failedSuites}`);
  console.log(`Missing: ${missingSuites}`);

  if (results.length > 0) {
    console.log('\nSuite Results:');
    for (const r of results) {
      const status = r.missing ? '✗ MISSING' : r.skipped ? '⚠ SKIPPED' : r.passed ? '✓ PASSED' : '✗ FAILED';
      const duration = r.duration ? ` (${r.duration}s)` : '';
      console.log(`  ${status} ${r.suite}${duration}`);
      if (r.error) {
        console.log(`    Error: ${r.error.slice(0, 100)}...`);
      }
    }
  }

  if (failedSuites > 0 || skippedSuites > 0 || missingSuites > 0) {
    console.log('\n✗ Production verification FAILED');
    process.exit(1);
  }

  console.log('\n✓ All mandatory production gates passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Verification gate error:', err);
  process.exit(1);
});
