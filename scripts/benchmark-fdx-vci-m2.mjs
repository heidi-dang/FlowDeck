#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m2.mjs — Milestone 2 EvidenceGraph benchmarks
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m2-evidencegraph.json");

function getReleaseBinaryPath() {
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);
  
  if (!existsSync(candidate)) {
    console.log("Building FDX binary for benchmark (release profile)...");
    execFileSync("cargo", ["build", "-p", "fdx", "--release"], { cwd: ROOT, stdio: "inherit" });
  }
  return candidate;
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

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 2 Benchmark ===");
  const binaryPath = getReleaseBinaryPath();
  const measuredSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  // Clear existing index to measure initial
  const fdxDir = join(ROOT, ".fdx");
  if (existsSync(fdxDir)) {
    rmSync(fdxDir, { recursive: true, force: true });
  }

  // Initial full index
  const tInitial0 = performance.now();
  execFileSync(binaryPath, ["index", "run"], { cwd: ROOT });
  const initialIndexMs = performance.now() - tInitial0;

  // Warm DB open / status
  const statusSamples = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["index", "status"], { cwd: ROOT });
    statusSamples.push(performance.now() - t0);
  }
  const warmStatusMs = computeStats(statusSamples);

  // Unchanged refresh
  const unchangedSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["index", "run"], { cwd: ROOT });
    unchangedSamples.push(performance.now() - t0);
  }
  const unchangedRefreshMs = computeStats(unchangedSamples);

  // Single-file refresh
  const testFilePath = join(ROOT, "src", "dummy_bench.ts");
  const singleFileSamples = [];
  for (let i = 0; i < 5; i++) {
    writeFileSync(testFilePath, `const a = ${i};`);
    const t0 = performance.now();
    execFileSync(binaryPath, ["index", "run"], { cwd: ROOT });
    singleFileSamples.push(performance.now() - t0);
  }
  const singleFileRefreshMs = computeStats(singleFileSamples);

  // Delete-file refresh
  rmSync(testFilePath);
  const tDelete0 = performance.now();
  execFileSync(binaryPath, ["index", "run"], { cwd: ROOT });
  const deleteFileRefreshMs = performance.now() - tDelete0;

  // Get status output
  const statusOutput = execFileSync(binaryPath, ["index", "status"], { cwd: ROOT, encoding: "utf8" });
  const lines = statusOutput.split("\n");
  let fileCount = 0;
  let nodeCount = 0;
  let edgeCount = 0;
  for (const line of lines) {
    if (line.startsWith("files=")) fileCount = parseInt(line.split("=")[1]);
    if (line.startsWith("nodes=")) nodeCount = parseInt(line.split("=")[1]);
    if (line.startsWith("edges=")) edgeCount = parseInt(line.split("=")[1]);
  }

  const dbSize = existsSync(join(fdxDir, "index.sqlite")) ? statSync(join(fdxDir, "index.sqlite")).size : 0;

  const baselineData = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    git: {
      measuredSha,
      branch: gitBranch,
    },
    metrics: {
      initialIndexMs: Number(initialIndexMs.toFixed(2)),
      warmStatusMs,
      unchangedRefreshMs,
      singleFileRefreshMs,
      deleteFileRefreshMs: Number(deleteFileRefreshMs.toFixed(2)),
      dbSizeBytes: dbSize,
      counts: {
        files: fileCount,
        nodes: nodeCount,
        edges: edgeCount,
      }
    }
  };

  const targetDir = resolve(REPORT_PATH, "..");
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(baselineData, null, 2), "utf8");
  console.log("M2 metrics recorded successfully to:", REPORT_PATH);
  console.log(JSON.stringify(baselineData.metrics, null, 2));
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
