#!/usr/bin/env node
/**
 * benchmark-fdx-vci.mjs — Baseline performance measurement for FDX VCI
 *
 * Captures machine-readable metrics and outputs JSON.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_REPORT_PATH = join(ROOT, "reports", "benchmark-fdx-vci-baseline.json");

function parseArgs() {
  const args = process.argv.slice(2);
  let isBaseline = false;
  let outputPath = DEFAULT_REPORT_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline") {
      isBaseline = true;
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputPath = resolve(args[i + 1]);
      i++;
    }
  }
  return { isBaseline, outputPath };
}

function getReleaseBinaryPath() {
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);
  const candidate2 = join(ROOT, "crates", "fdx", "target", "release", binaryName);

  if (!existsSync(candidate) && !existsSync(candidate2)) {
    console.log("Building FDX binary for benchmark (release profile)...");
    execFileSync("cargo", ["build", "-p", "fdx", "--release"], { cwd: ROOT, stdio: "inherit" });
  }

  if (existsSync(candidate)) return candidate;
  if (existsSync(candidate2)) return candidate2;
  throw new Error("Unable to locate built fdx binary (release)");
}

function computeStats(samples) {
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const max = samples[samples.length - 1];
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;

  return {
    count: samples.length,
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    p95: Number(p95.toFixed(2))
  };
}

async function measureDaemonOperations(binaryPath, workload) {
  const child = spawn(binaryPath, ["serve"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let stdoutBuffer = "";
  let reqIdCounter = 0;

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const json = JSON.parse(line);
        if (json.id && pending.has(json.id)) {
          const { resolve, timer } = pending.get(json.id);
          clearTimeout(timer);
          pending.delete(json.id);
          resolve(json);
        }
      } catch (err) {
        console.error("JSON parse error from daemon:", err);
      }
    }
  });

  new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Daemon exited with code ${code}`));
      }
      for (const [, { reject }] of pending) {
        reject(new Error("Daemon exited before response"));
      }
      pending.clear();
      resolve();
    });
  }).catch(err => {
    console.error("Daemon exited unexpectedly:", err);
  });

  function sendReq(op, args = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = `req-${++reqIdCounter}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${id} (${op})`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, op, args }) + "\n";
      child.stdin.write(payload);
    });
  }

  try {
    const tStart = performance.now();
    await sendReq("health");
    const daemonStartupMs = performance.now() - tStart;

    async function runSamples(op, args, iterations = 10) {
      await sendReq(op, args); // Warm up

      const samples = [];
      let lastOutputBytes = 0;

      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        const res = await sendReq(op, args);
        samples.push(performance.now() - t0);
        lastOutputBytes = Buffer.byteLength(JSON.stringify(res), "utf8");
      }
      return { stats: computeStats(samples), payloadBytes: lastOutputBytes };
    }

    const searchRes = await runSamples("search", { pattern: workload.searchQuery, path: workload.searchPath });
    const outlineRes = await runSamples("outline", { paths: workload.outlinePaths, depth: 2 });
    const impactRes = await runSamples("impact", { paths: workload.impactPaths, depth: workload.impactDepth, direction: "both" });

    return {
      daemonStartupMs: Number(daemonStartupMs.toFixed(2)),
      warmSearchMs: searchRes.stats,
      warmOutlineMs: outlineRes.stats,
      warmImpactMs: impactRes.stats,
      payloadBytes: {
        warmSearch: searchRes.payloadBytes,
        warmOutline: outlineRes.payloadBytes,
        warmImpact: impactRes.payloadBytes
      }
    };
  } finally {
    child.kill();
  }
}

async function runBenchmark() {
  const { isBaseline, outputPath } = parseArgs();
  if (!isBaseline) {
    console.warn("WARNING: Running without --baseline. The canonical baseline is not being overwritten.");
    console.warn("Add --baseline if this is an intentional update to the canonical reference.");
  }

  console.log("=== Running FDX VCI Baseline Benchmark ===");
  const binaryPath = getReleaseBinaryPath();

  const measuredSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  let baseSha = measuredSha;

  const workload = {
    repository: "FlowDeck",
    searchQuery: "Fdx",
    searchPath: "src",
    outlinePaths: ["src/index.ts"],
    impactPaths: ["src/index.ts"],
    impactDepth: 1
  };

  const launchSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["--version"], { cwd: ROOT });
    launchSamples.push(performance.now() - t0);
  }
  const binaryLaunchMs = computeStats(launchSamples);

  const readSamples = [];
  let readOutputBytes = 0;
  for (let i = 0; i < 5; i++) {
    const tRead0 = performance.now();
    const coldReadOut = execFileSync(binaryPath, ["read", "src/index.ts", "--mode", "prototype", "--format", "json"], { cwd: ROOT, encoding: "utf8" });
    readSamples.push(performance.now() - tRead0);
    readOutputBytes = Buffer.byteLength(coldReadOut, "utf8");
  }
  const oneShotReadMs = computeStats(readSamples);

  const daemonOps = await measureDaemonOperations(binaryPath, workload);
  const memUsage = process.memoryUsage();

  const baselineData = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    git: {
      baseSha,
      measuredSha,
      branch: gitBranch,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
      cargo: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
      profile: "release",
      observationalBinaryPath: binaryPath,
    },
    workload,
    metrics: {
      binaryLaunchMs,
      oneShotReadMs,
      daemonStartupMs: daemonOps.daemonStartupMs,
      warmSearchMs: daemonOps.warmSearchMs,
      warmOutlineMs: daemonOps.warmOutlineMs,
      warmImpactMs: daemonOps.warmImpactMs,
      harnessRssBytes: memUsage.rss,
      payloadBytes: {
        oneShotRead: readOutputBytes,
        warmSearch: daemonOps.payloadBytes.warmSearch,
        warmOutline: daemonOps.payloadBytes.warmOutline,
        warmImpact: daemonOps.payloadBytes.warmImpact,
      }
    }
  };

  if (isBaseline || outputPath !== DEFAULT_REPORT_PATH) {
    const targetDir = resolve(outputPath, "..");
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(baselineData, null, 2), "utf8");
    console.log("Baseline metrics recorded successfully to:", outputPath);
  } else {
    console.log("Metrics generated (dry run, not writing to baseline file):");
  }

  console.log(JSON.stringify(baselineData.metrics, null, 2));
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});