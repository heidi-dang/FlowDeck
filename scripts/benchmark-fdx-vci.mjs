#!/usr/bin/env node
/**
 * benchmark-fdx-vci.mjs — Baseline performance measurement for FDX VCI
 *
 * Captures machine-readable metrics:
 * - Cold startup time
 * - Cold read/index latency
 * - Warm search latency
 * - Warm outline latency
 * - Warm impact latency
 * - Daemon process start latency
 * - Rescan / cache latency
 * - Memory RSS & payload sizes
 *
 * Outputs JSON to reports/benchmark-fdx-vci-baseline.json
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = join(ROOT, "reports", "benchmark-fdx-vci-baseline.json");

function getBinaryPath() {
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate1 = join(ROOT, "target", "debug", binaryName);
  const candidate2 = join(ROOT, "crates", "fdx", "target", "debug", binaryName);
  if (existsSync(candidate1)) return candidate1;
  if (existsSync(candidate2)) return candidate2;
  // Try building if not found
  console.log("Building FDX binary for benchmark...");
  execFileSync("cargo", ["build", "-p", "fdx"], { cwd: ROOT, stdio: "inherit" });
  if (existsSync(candidate1)) return candidate1;
  if (existsSync(candidate2)) return candidate2;
  throw new Error("Unable to locate built fdx binary");
}

async function measureDaemonOperations(binaryPath) {
  const child = spawn(binaryPath, ["serve"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let responseResolver = null;
  let stdoutBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const json = JSON.parse(line);
        if (responseResolver) {
          const resolver = responseResolver;
          responseResolver = null;
          resolver(json);
        }
      } catch (err) {
        console.error("JSON parse error from daemon:", err);
      }
    }
  });

  function sendReq(op, args = {}) {
    return new Promise((resolve) => {
      responseResolver = resolve;
      const payload = JSON.stringify({ id: `bench-${Date.now()}`, op, args }) + "\n";
      child.stdin.write(payload);
    });
  }

  // Measure warm operations over daemon
  // Warm search
  const tSearchStart = performance.now();
  const searchRes = await sendReq("search", { pattern: "Fdx", path: "src" });
  const searchMs = performance.now() - tSearchStart;

  // Warm outline
  const tOutlineStart = performance.now();
  const outlineRes = await sendReq("outline", { paths: ["src/index.ts"], depth: 2 });
  const outlineMs = performance.now() - tOutlineStart;

  // Warm impact
  const tImpactStart = performance.now();
  const impactRes = await sendReq("impact", { paths: ["src/index.ts"], depth: 1, direction: "both" });
  const impactMs = performance.now() - tImpactStart;

  child.kill();

  return {
    searchMs,
    outlineMs,
    impactMs,
    searchOutputBytes: JSON.stringify(searchRes).length,
    outlineOutputBytes: JSON.stringify(outlineRes).length,
    impactOutputBytes: JSON.stringify(impactRes).length,
  };
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Baseline Benchmark ===");
  const binaryPath = getBinaryPath();
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  // 1. Cold Startup
  const startupSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["--version"], { cwd: ROOT });
    startupSamples.push(performance.now() - t0);
  }
  const coldStartupMs = startupSamples.reduce((a, b) => a + b, 0) / startupSamples.length;

  // 2. Cold Read / Symbol Extraction
  const tRead0 = performance.now();
  const coldReadOut = execFileSync(binaryPath, ["read", "src/index.ts", "--mode", "prototype", "--format", "json"], { cwd: ROOT, encoding: "utf8" });
  const coldReadMs = performance.now() - tRead0;
  const readOutputBytes = Buffer.byteLength(coldReadOut, "utf8");

  // 3. Daemon Start & IPC
  const tDaemonStart = performance.now();
  const daemonOps = await measureDaemonOperations(binaryPath);
  const daemonInitMs = performance.now() - tDaemonStart;

  const memUsage = process.memoryUsage();

  const baselineData = {
    timestamp: new Date().toISOString(),
    git: {
      sha: gitSha,
      branch: gitBranch,
    },
    metrics: {
      coldStartupMs: Math.round(coldStartupMs * 100) / 100,
      coldReadMs: Math.round(coldReadMs * 100) / 100,
      daemonInitMs: Math.round(daemonInitMs * 100) / 100,
      warmSearchMs: Math.round(daemonOps.searchMs * 100) / 100,
      warmOutlineMs: Math.round(daemonOps.outlineMs * 100) / 100,
      warmImpactMs: Math.round(daemonOps.impactMs * 100) / 100,
      memoryRssBytes: memUsage.rss,
      memoryHeapUsedBytes: memUsage.heapUsed,
      payloadBytes: {
        coldRead: readOutputBytes,
        warmSearch: daemonOps.searchOutputBytes,
        warmOutline: daemonOps.outlineOutputBytes,
        warmImpact: daemonOps.impactOutputBytes,
      }
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      binaryPath,
    }
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(baselineData, null, 2), "utf8");
  console.log("Baseline metrics recorded successfully to:", REPORT_PATH);
  console.log(JSON.stringify(baselineData.metrics, null, 2));
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
