/**
 * Update the routing policy / weights fingerprint manifest.
 *
 * Registers the CURRENT live fingerprints for the CURRENT versions into
 * src/orchestration/routing/fingerprints.json. Run this whenever a
 * version-governed policy value changes AND the version is bumped:
 *
 *   node scripts/update-routing-fingerprints.mjs
 *
 * Existing registered fingerprints for OTHER versions are preserved. The
 * manifest is committed; the CI gate
 * (scripts/check-routing-policy-version.mjs) fails if a policy changes
 * without a version bump or if an existing registered fingerprint is
 * overwritten.
 */

import { spawnSync } from "child_process"
import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"

const root = new URL("..", import.meta.url)
const manifestPath = new URL("src/orchestration/routing/fingerprints.json", root)

/** Locate the bun executable for spawning (matches check-coverage.mjs). */
function getBunExecutable() {
  if (process.platform !== "win32") return "bun"
  if (process.env.BUN_BIN && existsSync(process.env.BUN_BIN)) return process.env.BUN_BIN
  return "bun"
}

function existsSync(p) {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

/** Run the fingerprint report entry via bun and parse its JSON output. */
function computeReport() {
  const entry = fileURLToPath(new URL("src/orchestration/routing/fingerprint-report.ts", root))
  const result = spawnSync(getBunExecutable(), ["run", entry], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) {
    console.error(result.stderr || "fingerprint report failed")
    process.exit(result.status ?? 1)
  }
  const lines = result.stdout.trim().split("\n")
  const jsonLine = lines[lines.length - 1]
  return JSON.parse(jsonLine)
}

function main() {
  const report = computeReport()
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

  manifest.routingPolicyVersion = report.policyVersion
  manifest.weightsVersion = report.weightsVersion

  // Register the current fingerprint for the current version, preserving all
  // previously registered versions.
  manifest.routingPolicyFingerprints[report.policyVersion] = report.policyFingerprint
  manifest.weightsFingerprints[report.weightsVersion] = report.weightsFingerprint

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  console.log(
    `Registered routing policy fingerprint for ${report.policyVersion}: ${report.policyFingerprint}`,
  )
  console.log(
    `Registered weights fingerprint for ${report.weightsVersion}: ${report.weightsFingerprint}`,
  )
}

main()
