#!/usr/bin/env node

/**
 * Non-publishing release preflight.
 *
 * This validates the exact npm pack artifact that a tag workflow would publish:
 * package identity, forbidden contents, isolated installation, CLI loading,
 * and packaged doctor execution. It never contacts npm publish and never
 * requires release credentials.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "flowdeck-release-preflight-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function fail(message) {
  console.error(`Release preflight failed: ${message}`);
  process.exitCode = 1;
}

try {
  if (packageJson.name !== "@heidi-dang/flowdeck") fail(`unexpected package name ${packageJson.name}`);
  if (!/^2\.0\.0-alpha\.\d+$/.test(packageJson.version)) {
    fail(`unsupported prerelease version ${packageJson.version}`);
  }

  const packJson = JSON.parse(run("npm", ["pack", "--pack-destination", work, "--json"]));
  const packed = packJson[0];
  if (!packed?.filename) throw new Error("npm pack returned no artifact");
  const artifact = join(work, packed.filename);
  const files = packed.files.map((entry) => entry.path);
  const required = [
    "package.json",
    "bin/flowdeck.js",
    "dist/index.js",
    "src/doctor/cli.mjs",
    "postinstall.mjs",
    "scripts/check-schema-generated.mjs",
    "schema-v0.2.6.sql",
    "src/orchestration/persistence/migrations/schema-embed.ts",
  ];
  const missing = required.filter((path) => !files.includes(path));
  if (missing.length) throw new Error(`required package files missing: ${missing.join(", ")}`);

  const forbidden = files.filter((path) =>
    /(^|\/)(\.env|\.npmrc|\.git|coverage|node_modules|target|.*\.sqlite(?:-shm|-wal)?|.*\.db|.*\.log)$/.test(path) ||
    /\.(tgz|tmp|bak)$/.test(path)
  );
  if (forbidden.length) throw new Error(`forbidden package files present: ${forbidden.join(", ")}`);

  const installPrefix = join(work, "install");
  run("npm", ["install", "--prefix", installPrefix, artifact, "--no-audit", "--no-fund"]);
  const bin = join(installPrefix, "node_modules", ".bin", "flowdeck");
  run(bin, ["--help"]);
  const doctor = run(bin, ["doctor", "--json"]);
  const report = JSON.parse(doctor);
  if (!report || typeof report !== "object" || !report.status) {
    throw new Error("packaged doctor returned an invalid report");
  }
  const packagedSchema = join(installPrefix, "node_modules", "@heidi-dang", "flowdeck", "scripts", "check-schema-generated.mjs");
  const schemaOutput = run("node", [packagedSchema], { cwd: join(installPrefix, "node_modules", "@heidi-dang", "flowdeck") });
  if (!schemaOutput.includes("Schema validation: ALL PASS")) {
    throw new Error("packaged schema fallback validation did not pass");
  }

  console.log(JSON.stringify({
    status: "PASS",
    package: packageJson.name,
    version: packageJson.version,
    artifact: packed.filename,
    packageSize: packed.size,
    files: files.length,
    install: "PASS",
    cli: "PASS",
    doctor: report.status,
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
