#!/usr/bin/env node
/**
 * Non-vacuous qualification harness for the live orchestration runtime.
 *
 * It is intentionally independent of the broad pre-push gate: this harness
 * proves the authority-specific scenarios, measures their actual runtime, and
 * verifies that accepted V1–V14 migration sources still match the frozen
 * checkpoint manifest before a report can be published.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const outputPath = resolve(root, args.get("--output") ?? "reports/qualification-live-runtime.json");
const migrationBaseline = resolve(args.get("--migration-baseline") ?? "/home/ubuntu/flowdeck-live-runtime-migration-hashes-before.txt");

function command(command, commandArgs, label) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const outcome = {
    label,
    command: [command, ...commandArgs].join(" "),
    startedAt,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    passed: result.status === 0 && !result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  process.stdout.write(`\n[qualification] ${label}: ${outcome.passed ? "PASS" : "FAIL"} (${durationMs}ms)\n`);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  return outcome;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verifyFrozenMigrations() {
  if (!existsSync(migrationBaseline)) {
    return { passed: false, reason: `Frozen migration manifest is missing: ${migrationBaseline}`, compared: [] };
  }
  const expected = readFileSync(migrationBaseline, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
      if (!match) throw new Error(`Invalid frozen migration manifest entry: ${line}`);
      return { hash: match[1], path: match[2] };
    });
  // The registry is intentionally forward-mutated to register V15.  It is
  // reported separately; every frozen migration implementation and support
  // source from the accepted V1–V14 checkpoint remains byte-identical.
  const excludedByForwardMigration = expected.filter(entry => entry.path.endsWith("migration-registry.ts"));
  const compared = expected
    .filter(entry => !entry.path.endsWith("migration-registry.ts"))
    .map(entry => {
      const path = entry.path.startsWith("/") ? entry.path : resolve(root, entry.path);
      const actual = existsSync(path) ? sha256(path) : null;
      return { path, expected: entry.hash, actual, matches: actual === entry.hash };
    });
  return {
    passed: compared.every(item => item.matches),
    compared,
    excludedByForwardMigration: excludedByForwardMigration.map(entry => entry.path),
  };
}

function gitValue(args, label) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${label} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const startedAt = new Date().toISOString();
const head = gitValue(["rev-parse", "HEAD"], "rev-parse");
const branch = gitValue(["branch", "--show-current"], "branch");
const treeStatus = gitValue(["status", "--porcelain"], "status");
const checks = [];
checks.push({
  label: "clean-functional-sha",
  passed: treeStatus.length === 0,
  head,
  branch,
  detail: treeStatus.length === 0 ? "working tree clean" : treeStatus,
});
checks.push({ label: "frozen-v1-v14-migrations", ...verifyFrozenMigrations() });
checks.push(command("node", ["scripts/check-schema-generated.mjs"], "frozen-schema"));
checks.push(command("bun", ["scripts/orchestration/verify-schema.mjs"], "live-schema"));
checks.push(command("bun", [
  "test",
  "tests/live-verification-authority.test.ts",
  "tests/continuation-dispatch-durability.test.ts",
  "tests/orchestration-production-wiring.test.ts",
], "authority-replacement-continuation-regressions"));
checks.push(command("bun", ["test", "tests/doctor-cli.test.ts"], "doctor-observability-regressions"));

const performanceRuns = [];
for (let index = 1; index <= 3; index += 1) {
  performanceRuns.push(command("bun", [
    "test",
    "tests/live-verification-authority.test.ts",
    "tests/continuation-dispatch-durability.test.ts",
  ], `authority-performance-${index}`));
}
const performanceDurations = performanceRuns.map(run => run.durationMs).sort((left, right) => left - right);
const performanceSummary = {
  runs: performanceRuns.map(run => ({ passed: run.passed, durationMs: run.durationMs })),
  medianMs: performanceDurations[1],
  maxMs: performanceDurations[performanceDurations.length - 1],
  thresholdMs: 5000,
  passed: performanceRuns.every(run => run.passed) && performanceDurations[performanceDurations.length - 1] < 5000,
};
checks.push({ label: "authority-performance", ...performanceSummary });

const report = {
  schemaVersion: 1,
  kind: "flowdeck-live-runtime-qualification",
  startedAt,
  finishedAt: new Date().toISOString(),
  functionalSha: head,
  branch,
  overallPassed: checks.every(check => check.passed),
  checks,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`\n[qualification] report: ${outputPath}\n`);
process.stdout.write(`[qualification] overall: ${report.overallPassed ? "PASS" : "FAIL"}\n`);
process.exit(report.overallPassed ? 0 : 1);
