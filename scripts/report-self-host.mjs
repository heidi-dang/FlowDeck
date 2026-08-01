import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

async function generateSelfHostReport() {
  console.log("Generating Evidence-Backed FlowDeck Production Self-Host Verification Report...\n");

  const cwd = process.cwd();

  // 1. Inspect Git HEAD SHA & Branch dynamically
  let gitSha = "";
  let branch = "";
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
  } catch {
    console.error("FAIL: Could not determine git HEAD SHA or branch.");
    process.exit(1);
  }

  if (!gitSha || gitSha.length !== 40) {
    console.error(`FAIL: Invalid git SHA '${gitSha}'.`);
    process.exit(1);
  }

  // 2. Validate Benchmark Artifacts Existence and SHA/Budget Compliance
  const streamingBenchPath = resolve(cwd, "artifacts/benchmark-streaming.json");
  const uiBenchPath = resolve(cwd, "artifacts/benchmark-ui.json");

  if (!existsSync(streamingBenchPath)) {
    console.error("FAIL: Required artifact 'artifacts/benchmark-streaming.json' is absent. Run 'npm run benchmark:streaming' first.");
    process.exit(1);
  }

  if (!existsSync(uiBenchPath)) {
    console.error("FAIL: Required artifact 'artifacts/benchmark-ui.json' is absent. Run 'npm run benchmark:ui' first.");
    process.exit(1);
  }

  let streamingBench;
  let uiBench;

  try {
    streamingBench = JSON.parse(readFileSync(streamingBenchPath, "utf-8"));
    uiBench = JSON.parse(readFileSync(uiBenchPath, "utf-8"));
  } catch (err) {
    console.error("FAIL: Could not parse benchmark JSON artifacts:", err);
    process.exit(1);
  }

  // Enforce Benchmark Budgets dynamically
  const commitOps = streamingBench.metrics?.sqliteCommitLatency?.opsPerSec || 0;
  if (commitOps < 1000) {
    console.error(`FAIL: SQLite commit throughput (${commitOps} ops/sec) below minimum budget (1000 ops/sec).`);
    process.exit(1);
  }

  const renderFpsPassed = uiBench.metrics?.frameStability?.passed;
  if (renderFpsPassed !== true) {
    console.error("FAIL: UI render frame stability benchmark failed 60 FPS budget.");
    process.exit(1);
  }

  // Check git working tree clean status
  let isDirty = false;
  try {
    const statusOut = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    isDirty = statusOut.length > 0;
  } catch { /* ignore */ }

  if (isDirty && !process.argv.includes("--allow-dirty")) {
    console.error("FAIL: Working tree is dirty. Self-host report requires a clean git working tree.");
    process.exit(1);
  }

  // Enforce: benchmark artifact SHA must match HEAD or be an ancestor with no underlying production code changes
  function requireExactSha(artifactSha, artifactName) {
    if (!artifactSha) {
      console.error(`FAIL: ${artifactName} artifact missing gitSha field. Regenerate with: npm run ${artifactName === 'streaming' ? 'benchmark:streaming' : 'benchmark:ui'}`);
      process.exit(1);
    }
    if (artifactSha === gitSha) return; // exact match
    try {
      execSync(`git merge-base --is-ancestor ${artifactSha} HEAD`, { encoding: 'utf-8' });
      const changedFiles = execSync(`git diff --name-only ${artifactSha} HEAD`, { encoding: 'utf-8' }).trim().split('\n');
      const codeChanges = changedFiles.filter(f => f && !f.startsWith('artifacts/') && f !== 'scripts/report-self-host.mjs');
      if (codeChanges.length > 0) {
        console.error(`FAIL: ${artifactName} benchmark SHA (${artifactSha}) has unbenchmarked code changes up to HEAD: ${codeChanges.join(', ')}.`);
        process.exit(1);
      }
    } catch (err) {
      if (err.message?.includes('unbenchmarked')) throw err;
      console.error(`FAIL: ${artifactName} benchmark SHA (${artifactSha}) is not a valid ancestor of current HEAD (${gitSha}).`);
      process.exit(1);
    }
  }
  requireExactSha(streamingBench.gitSha, 'streaming');
  requireExactSha(uiBench.gitSha, 'ui');

  // 3. Inspect GitHub CI Runs for Exact SHA dynamically using gh CLI
  let ciRunDetails = null;
  const allowPending = process.argv.includes("--allow-pending-remote");
  try {
    const ciJson = execSync(
      `gh run list --branch ${branch} --limit 10 --json databaseId,headSha,status,conclusion,workflowName`,
      { encoding: "utf-8" }
    ).trim();

    const runs = JSON.parse(ciJson);
    const codeChanges = changedFiles.filter(f => f && !f.startsWith('artifacts/') && f !== 'scripts/report-self-host.mjs');
    const matchingRuns = runs.filter((r) => r.headSha === gitSha);

    if (matchingRuns.length === 0) {
      if (!allowPending) {
        console.error(`FAIL: No remote GitHub CI runs found matching exact HEAD SHA ${gitSha} on branch ${branch}.`);
        process.exit(1);
      }
      ciRunDetails = { status: "PENDING_REMOTE_PUSH", matchingSha: gitSha };
    } else {
      // Require both mandatory workflows to be present and succeeded
      const MANDATORY_WORKFLOWS = ['CI Production Gates', 'Orchestration Validation'];
      for (const wf of MANDATORY_WORKFLOWS) {
        const run = matchingRuns.find(r => r.workflowName === wf);
        if (!run) {
          if (!allowPending) {
            console.error(`FAIL: Mandatory workflow '${wf}' not found for SHA ${gitSha}.`);
            process.exit(1);
          }
        } else if (run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out' || run.conclusion === 'action_required') {
          console.error(`FAIL: Mandatory workflow '${wf}' (run ${run.databaseId}) concluded '${run.conclusion}' for SHA ${gitSha}.`);
          process.exit(1);
        } else if ((run.status === 'in_progress' || run.status === 'queued') && !allowPending) {
          console.error(`FAIL: Mandatory workflow '${wf}' (run ${run.databaseId}) is still '${run.status}' for SHA ${gitSha}.`);
          process.exit(1);
        }
      }

      const failedRun = matchingRuns.find(r => r.conclusion === "failure" || r.conclusion === "cancelled");
      if (failedRun) {
        console.error(`FAIL: Remote CI run ${failedRun.databaseId} (${failedRun.workflowName}) for SHA ${gitSha} failed on GitHub (${failedRun.conclusion}).`);
        process.exit(1);
      }

      ciRunDetails = matchingRuns.map(r => ({
        runId: r.databaseId,
        headSha: r.headSha,
        workflow: r.workflowName,
        status: r.status,
        conclusion: r.conclusion,
      }));
    }
  } catch (err) {
    if (!allowPending) {
      console.error("FAIL: Could not verify remote GitHub CI status via gh CLI:", err.message);
      process.exit(1);
    }
    ciRunDetails = { status: "UNCHECKED_LOCAL_ONLY", headSha: gitSha };
  }

  // 4. Verify Production Integration, Accessibility, Browser E2E, and Load Tests
  try {
    execSync("bun test tests/better-harness/production-server-integration.test.ts", { stdio: "pipe" });
    execSync("bun test tests/ui/accessibility.test.ts", { stdio: "pipe" });
    execSync("bun test tests/ui/browser-e2e.test.ts", { stdio: "pipe" });
    execSync("bun test tests/streaming/http-sse-load-soak.test.ts", { stdio: "pipe" });
  } catch (err) {
    console.error("FAIL: Required production gate tests failed execution:", err.message);
    process.exit(1);
  }

  // 5. Construct Dynamic Evidence Report
  const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf-8"));

  const report = {
    reportType: "Evidence-Backed Production Self-Host Verification",
    timestamp: new Date().toISOString(),
    git: {
      branch,
      sha: gitSha,
      dirty: isDirty,
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      version: pkg.version,
      cpuCount: (await import("os")).cpus().length,
      totalMemoryMb: Math.round((await import("os")).totalmem() / (1024 * 1024)),
    },
    productionWiringVerified: 'ALL_GATE_TESTS_PASSED',
    benchmarkEvidence: {
      streaming: {
        file: "artifacts/benchmark-streaming.json",
        sqliteCommitOpsPerSec: commitOps,
        publisherCommitAndDispatchMs: streamingBench.metrics?.publisherCommitAndBrokerDispatch?.medianMs,
        publishLatencyMedianMs: streamingBench.metrics?.publishToClientReceipt?.medianMs,
        reconnectReplaysPerSec: streamingBench.metrics?.reconnectReplay?.replaysPerSec,
      },
      ui: {
        file: "artifacts/benchmark-ui.json",
        reductionsPerSec: uiBench.metrics?.browserEventToReducer?.reductionsPerSec,
        rendersPerSec: uiBench.metrics?.reducerToDomRender?.rendersPerSec,
        maxRenderMs: uiBench.metrics?.frameStability?.measuredMaxRenderMs,
        frame60FpsBudget: uiBench.metrics?.frameStability?.passed ? "PASSED" : "FAILED",
      },
    },
    remoteCiVerification: ciRunDetails,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("\nEvidence-backed self-host verification report PASSED.");
}

generateSelfHostReport().catch((err) => {
  console.error("Failed to generate self-host report:", err);
  process.exit(1);
});
