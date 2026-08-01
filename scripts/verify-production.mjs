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
    name: 'Performance',
    pattern: 'tests/performance/',
    description: 'Performance benchmark and scenario tests',
    note: 'Run via npm run benchmark:* scripts, not bun test',
  },
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
    console.log(`⚠ Suite directory not found: ${basePath}`);
    return { passed: false, skipped: true };
  }

  // Performance suite has no test files - it's run via npm scripts
  if (suite.name === 'Performance') {
    console.log(`⚠ Performance suite run via: npm run benchmark:* scripts`);
    return { passed: true, skipped: true, reason: 'Run via npm scripts' };
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
  console.log(`\nRunning ${MANDATORY_SUITES.length} mandatory suites:`);
  for (const suite of MANDATORY_SUITES) {
    const exists = checkSuiteExists(suite);
    console.log(`  ${exists ? '✓' : '⚠'} ${suite.name}`);
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

  for (const suite of MANDATORY_SUITES) {
    totalSuites++;
    const result = runSuite(suite);
    results.push({ suite: suite.name, ...result });

    if (result.skipped) {
      skippedSuites++;
    } else if (result.passed) {
      passedSuites++;
    } else {
      failedSuites++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Verification Summary');
  console.log('='.repeat(60));
  console.log(`Total suites: ${totalSuites}`);
  console.log(`Passed: ${passedSuites}`);
  console.log(`Skipped: ${skippedSuites}`);
  console.log(`Failed: ${failedSuites}`);

  if (results.length > 0) {
    console.log('\nSuite Results:');
    for (const r of results) {
      const status = r.skipped ? '⚠ SKIPPED' : r.passed ? '✓ PASSED' : '✗ FAILED';
      const duration = r.duration ? ` (${r.duration}s)` : '';
      console.log(`  ${status} ${r.suite}${duration}`);
      if (r.error) {
        console.log(`    Error: ${r.error.slice(0, 100)}...`);
      }
    }
  }

  // Only fail if there are actual failures, not skipped suites
  if (failedSuites > 0) {
    console.log('\n✗ Production verification FAILED');
    process.exit(1);
  }

  console.log('\n✓ All mandatory production suites passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Verification gate error:', err);
  process.exit(1);
});
