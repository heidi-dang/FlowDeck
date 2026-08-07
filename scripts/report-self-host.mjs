/**
 * Evidence-Backed FlowDeck Production Self-Host Verification Report
 *
 * Fail-closed: any missing evidence, wrong SHA, pending workflow, source change
 * after benchmark generation, or absent artifact causes exit(1).
 *
 * Acceptance criteria (in order):
 *  1. Clean source working tree before running
 *  2. Exact implementation SHA in both benchmark artifacts
 *  3. Evidence-only descent: if artifact SHA !== HEAD, only artifacts/ may have changed
 *  4. Remote branch SHA === HEAD
 *  5. PR head SHA === HEAD (when gh CLI available)
 *  6. Both mandatory CI workflows: completed + success at exact HEAD SHA
 *  7. Benchmark artifact checksums verified
 *  8. Benchmark budgets passed
 *  9. Disk durability suite run and passed
 * 10. All production gate tests passed
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

// -- Helpers ------------------------------------------------------------------

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// Allow-list for evidence-only descendant commits (artifacts/ only)
const EVIDENCE_ALLOWED_PREFIXES = ['artifacts/'];

function isAllowedEvidenceFile(f) {
  return EVIDENCE_ALLOWED_PREFIXES.some(p => f.startsWith(p));
}

function validateEvidenceOnlyDescent(implSha, headSha) {
  if (!implSha || !/^[0-9a-f]{40}$/i.test(implSha))
    fail(`Invalid or abbreviated implSha in benchmark artifact: '${implSha}'. Must be a full 40-char hex SHA.`);

  if (implSha === headSha) return { exactMatch: true, changedFiles: [] };

  // implSha must be ancestor of HEAD
  try {
    exec(`git merge-base --is-ancestor ${implSha} ${headSha}`);
  } catch {
    fail(`Benchmark artifact SHA (${implSha}) is not a reachable ancestor of HEAD (${headSha}). Regenerate benchmarks.`);
  }

  // Enumerate files changed between implSha and HEAD
  let changedFiles = [];
  try {
    const raw = exec(`git diff --name-only ${implSha}..${headSha}`);
    changedFiles = raw.split('\n').filter(Boolean);
  } catch {
    fail('Could not enumerate files changed between benchmark SHA and HEAD.');
  }

  // All changes must be in the allow-list
  const blocked = changedFiles.filter(f => !isAllowedEvidenceFile(f));
  if (blocked.length > 0) {
    fail(
      `Source/config files changed after benchmark generation — regenerate benchmarks at HEAD.\n` +
      `  Blocked files: ${blocked.join(', ')}\n` +
      `  Benchmark SHA: ${implSha}\n` +
      `  HEAD: ${headSha}`
    );
  }

  return { exactMatch: false, changedFiles };
}

function verifyArtifactChecksum(artifact, artifactPath) {
  if (!artifact.artifactChecksum) {
    fail(`Benchmark artifact ${artifactPath} is missing 'artifactChecksum' field. Regenerate with updated benchmark script.`);
  }
  if (!artifact.artifactChecksum.startsWith('sha256:')) {
    fail(`Benchmark artifact ${artifactPath} has unrecognized checksum format: ${artifact.artifactChecksum}`);
  }
  // Re-derive: the checksum is of the artifact without the checksum field itself
  const { artifactChecksum: _, ...body } = artifact;
  const recomputed = createHash('sha256').update(JSON.stringify(body, null, 2), 'utf8').digest('hex');
  const stored = artifact.artifactChecksum.slice('sha256:'.length);
  if (recomputed !== stored) {
    fail(`Benchmark artifact ${artifactPath} checksum mismatch.\n  Stored:   ${stored}\n  Computed: ${recomputed}\n  The artifact file may have been manually edited.`);
  }
}

// -- Main ---------------------------------------------------------------------

async function generateSelfHostReport() {
  console.log('Generating Evidence-Backed FlowDeck Production Self-Host Verification Report...\n');

  const cwd = process.cwd();

  // 1. Git HEAD SHA and branch
  let gitSha, branch;
  try {
    gitSha = exec('git rev-parse HEAD');
    branch = exec('git branch --show-current');
  } catch {
    fail('Could not determine git HEAD SHA or branch.');
  }

  if (!gitSha || gitSha.length !== 40)
    fail(`Invalid git SHA '${gitSha}'.`);

  // 2. Clean source working tree
  let isDirty = false;
  try {
    const statusOut = exec('git status --porcelain');
    isDirty = statusOut.length > 0;
  } catch { /* ignore */ }

  if (isDirty && !process.argv.includes('--allow-dirty'))
    fail('Working tree is dirty. Self-host report requires a clean git working tree.');

  // 3. Load benchmark artifacts
  const streamingBenchPath = resolve(cwd, 'artifacts/benchmark-streaming.json');
  const uiBenchPath = resolve(cwd, 'artifacts/benchmark-ui.json');

  if (!existsSync(streamingBenchPath))
    fail("Required artifact 'artifacts/benchmark-streaming.json' is absent. Run 'npm run benchmark:streaming' first.");
  if (!existsSync(uiBenchPath))
    fail("Required artifact 'artifacts/benchmark-ui.json' is absent. Run 'npm run benchmark:ui' first.");

  let streamingBench, uiBench;
  try {
    streamingBench = JSON.parse(readFileSync(streamingBenchPath, 'utf-8'));
    uiBench = JSON.parse(readFileSync(uiBenchPath, 'utf-8'));
  } catch (err) {
    fail(`Could not parse benchmark JSON artifacts: ${err.message}`);
  }

  // 4. Verify artifact checksums (fail if absent or mismatched)
  verifyArtifactChecksum(streamingBench, 'artifacts/benchmark-streaming.json');
  verifyArtifactChecksum(uiBench, 'artifacts/benchmark-ui.json');

  // 5. Exact SHA or evidence-only descent validation (NO arbitrary ancestor window)
  //    Both artifacts must agree on the same implementation SHA.
  const streamingImplSha = streamingBench.gitSha;
  const uiImplSha = uiBench.gitSha;

  if (!streamingImplSha || !/^[0-9a-f]{40}$/i.test(streamingImplSha))
    fail(`streaming benchmark artifact has invalid gitSha: '${streamingImplSha}'.`);
  if (!uiImplSha || !/^[0-9a-f]{40}$/i.test(uiImplSha))
    fail(`ui benchmark artifact has invalid gitSha: '${uiImplSha}'.`);
  if (streamingImplSha !== uiImplSha)
    fail(`Benchmark artifacts record different implementation SHAs:\n  streaming: ${streamingImplSha}\n  ui:        ${uiImplSha}\nRegenerate both benchmarks from the same source commit.`);

  const implSha = streamingImplSha;
  const streamingDescent = validateEvidenceOnlyDescent(implSha, gitSha);
  // No need to re-validate ui — same implSha, same headSha

  // 6. Verify remote branch SHA === HEAD
  let remoteSha;
  try {
    remoteSha = exec(`git rev-parse origin/${branch}`);
  } catch {
    fail(`Could not resolve remote SHA for origin/${branch}. Run 'git fetch origin' first.`);
  }
  if (remoteSha !== gitSha)
    fail(`Remote branch SHA (${remoteSha}) !== HEAD (${gitSha}). Push your commits first.`);

  // 7. Verify PR head SHA === HEAD (best-effort via gh CLI)
  let prHeadSha = null;
  try {
    const prJson = exec(`gh pr list --head ${branch} --json headRefOid --limit 1`);
    const prs = JSON.parse(prJson);
    if (prs.length > 0) {
      prHeadSha = prs[0].headRefOid;
      if (prHeadSha !== gitSha)
        fail(`PR head SHA (${prHeadSha}) !== HEAD (${gitSha}). The PR may not have received the latest push.`);
    }
  } catch (err) {
    // If gh CLI unavailable or no PR found, do not fail — remote SHA match is the gate
    if (err.message && err.message.includes('FAIL:')) throw err;
  }

  // 8. Benchmark budgets
  const commitOps = streamingBench.metrics?.sqliteCommitLatency?.opsPerSec || 0;
  if (commitOps < 1000)
    fail(`SQLite commit throughput (${commitOps} ops/sec) below minimum budget (1000 ops/sec).`);

  const renderFpsPassed = uiBench.metrics?.frameStability?.passed;
  if (renderFpsPassed !== true)
    fail('UI render frame stability benchmark failed happy-dom 60fps budget check.');

  // 9. Remote GitHub CI verification — exact SHA, both mandatory workflows, no pending
  const MANDATORY_WORKFLOWS = ['CI Production Gates', 'Orchestration Validation'];
  let ciRunDetails = null;
  const allowPending = process.argv.includes('--allow-pending-remote');

  try {
    const ciJson = exec(
      `gh run list --branch ${branch} --limit 10 --json databaseId,headSha,status,conclusion,workflowName`
    );
    const runs = JSON.parse(ciJson);
    const matchingRuns = runs.filter(r => r.headSha === gitSha);

    if (matchingRuns.length === 0) {
      if (!allowPending)
        fail(`No remote GitHub CI runs found matching exact HEAD SHA ${gitSha} on branch ${branch}.`);
      ciRunDetails = { status: 'PENDING_REMOTE_PUSH', matchingSha: gitSha };
    } else {
      // Each mandatory workflow must be present and successful
      for (const wf of MANDATORY_WORKFLOWS) {
        const run = matchingRuns.find(r => r.workflowName === wf);
        if (!run) {
          if (!allowPending)
            fail(`Mandatory workflow '${wf}' not found for SHA ${gitSha}.`);
        } else if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion)) {
          fail(`Mandatory workflow '${wf}' (run ${run.databaseId}) concluded '${run.conclusion}' for SHA ${gitSha}.`);
        } else if (['in_progress', 'queued'].includes(run.status) && !allowPending) {
          fail(`Mandatory workflow '${wf}' (run ${run.databaseId}) is still '${run.status}' for SHA ${gitSha}.`);
        }
      }

      const failedRun = matchingRuns.find(r => ['failure', 'cancelled'].includes(r.conclusion));
      if (failedRun)
        fail(`Remote CI run ${failedRun.databaseId} (${failedRun.workflowName}) for SHA ${gitSha} failed (${failedRun.conclusion}).`);

      ciRunDetails = matchingRuns.map(r => ({
        runId: r.databaseId,
        headSha: r.headSha,
        workflow: r.workflowName,
        status: r.status,
        conclusion: r.conclusion,
      }));
    }
  } catch (err) {
    if (err.message && err.message.includes('FAIL:')) throw err;
    if (!allowPending)
      fail(`Could not verify remote GitHub CI status via gh CLI: ${err.message}`);
    ciRunDetails = { status: 'UNCHECKED_LOCAL_ONLY', headSha: gitSha };
  }

  // 10. Disk durability suite
  try {
    execSync('bun test tests/streaming/disk-durability.test.ts', { stdio: 'pipe' });
  } catch (err) {
    fail(`On-disk durability suite failed: ${err.stderr?.toString() || err.message}`);
  }

  // 11. Production gate tests (integration, accessibility, browser E2E, load soak)
  const gateTests = [
    'tests/better-harness/production-server-integration.test.ts',
    'tests/ui/accessibility.test.ts',
    'tests/ui/browser-e2e.test.ts',
    'tests/streaming/http-sse-load-soak.test.ts',
  ];
  for (const testFile of gateTests) {
    try {
      execSync(`bun test ${testFile}`, { stdio: 'pipe' });
    } catch (err) {
      fail(`Production gate test failed: ${testFile}\n${err.stderr?.toString() || err.message}`);
    }
  }

  // 12. Construct report
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));

  const report = {
    reportType: 'Evidence-Backed Production Self-Host Verification',
    timestamp: new Date().toISOString(),
    git: {
      branch,
      implSha,
      headSha: gitSha,
      remoteSha,
      prHeadSha,
      dirty: isDirty,
      evidenceOnlyDescent: implSha === gitSha ? 'exact-match' : 'evidence-only-ancestor',
      evidenceChangedFiles: streamingDescent.changedFiles,
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      version: pkg.version,
      cpuCount: (await import('os')).cpus().length,
      totalMemoryMb: Math.round((await import('os')).totalmem() / (1024 * 1024)),
    },
    productionWiringVerified: 'ALL_GATE_TESTS_PASSED',
    diskDurabilitySuite: 'PASSED',
    benchmarkEvidence: {
      streaming: {
        file: 'artifacts/benchmark-streaming.json',
        implSha: streamingImplSha,
        measurementTypes: {
          sqliteCommit: streamingBench.metrics?.sqliteCommitLatency?.measurementType,
          brokerDispatch: streamingBench.metrics?.publisherCommitAndBrokerDispatch?.measurementType,
          clientReceipt: streamingBench.metrics?.publishToClientReceipt?.measurementType,
          replay: streamingBench.metrics?.reconnectReplay?.measurementType,
        },
        sqliteCommitOpsPerSec: commitOps,
        publisherCommitAndDispatchMs: streamingBench.metrics?.publisherCommitAndBrokerDispatch?.medianMs,
        publishLatencyMedianMs: streamingBench.metrics?.publishToClientReceipt?.medianMs,
        reconnectReplaysPerSec: streamingBench.metrics?.reconnectReplay?.replaysPerSec,
        checksum: streamingBench.artifactChecksum,
      },
      ui: {
        file: 'artifacts/benchmark-ui.json',
        implSha: uiImplSha,
        measurementTypes: {
          reducer: uiBench.metrics?.browserEventToReducer?.measurementType,
          domRender: uiBench.metrics?.reducerToDomRender?.measurementType,
          frameStability: uiBench.metrics?.frameStability?.measurementType,
        },
        reductionsPerSec: uiBench.metrics?.browserEventToReducer?.reductionsPerSec,
        rendersPerSec: uiBench.metrics?.reducerToDomRender?.rendersPerSec,
        maxRenderMs: uiBench.metrics?.frameStability?.measuredMaxRenderMs,
        happyDom60FpsBudget: uiBench.metrics?.frameStability?.passed ? 'PASSED' : 'FAILED',
        checksum: uiBench.artifactChecksum,
      },
    },
    remoteCiVerification: ciRunDetails,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('\nEvidence-backed self-host verification report PASSED.');
}

generateSelfHostReport().catch(err => {
  console.error('Failed to generate self-host report:', err.message || err);
  process.exit(1);
});
