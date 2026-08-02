/**
 * Routing policy / weights version gate.
 *
 * Enforces that every change to a version-governed canonical routing policy
 * value or scoring weight is accompanied by a corresponding version increment
 * and fingerprint registration. The gate is diff-based: the merge-base
 * manifest is compared against the current branch manifest, so a registered
 * historical fingerprint can never be silently rewritten, and the current
 * version must always be present in the manifest with a fingerprint equal to
 * the LIVE hash of the canonical values.
 *
 * The check hashes live canonical values — it cannot be satisfied by editing
 * a fixture. When a version-governed policy value changes, the developer MUST
 * bump ROUTING_POLICY_VERSION (or ROUTING_WEIGHTS_VERSION) and re-run
 * `node scripts/update-routing-fingerprints.mjs` to register the new
 * fingerprint.
 *
 * Fails when:
 *   - the policy fingerprint changed without a routing policy version bump;
 *   - the weights fingerprint changed without a weights version bump;
 *   - a version changed without its fingerprint being registered;
 *   - the current version is missing from the manifest;
 *   - an existing registered historical fingerprint was modified.
 *
 * Usage:
 *   node scripts/check-routing-policy-version.mjs --base <sha> --head HEAD
 */

import { spawnSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const MANIFEST_PATH = "src/orchestration/routing/fingerprints.json"
const REPORT_ENTRY = "src/orchestration/routing/fingerprint-report.ts"

/**
 * Locate the native bun executable for spawnSync without shell execution.
 * Mirrors scripts/check-coverage.mjs.
 */
export function getBunExecutable() {
  if (process.platform !== "win32") return "bun"

  if (process.env.BUN_BIN && existsSync(process.env.BUN_BIN)) {
    return process.env.BUN_BIN
  }

  const appData = process.env.APPDATA
  if (appData) {
    const npmBunExe = join(appData, "npm", "node_modules", "bun", "bin", "bun.exe")
    if (existsSync(npmBunExe)) return npmBunExe
  }

  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    const userBunExe = join(userProfile, ".bun", "bin", "bun.exe")
    if (existsSync(userBunExe)) return userBunExe
  }

  return "bun.exe"
}

/** Run `git show <sha>:<path>` and return the file content, or undefined if the file does not exist at that ref. */
function gitShowFile(sha, path) {
  const proc = spawnSync("git", ["show", `${sha}:${path}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (proc.status !== 0) return undefined
  return proc.stdout
}

/** Parse a fingerprint manifest JSON file, tolerating a missing file. */
function parseManifest(json) {
  if (json === undefined || json === null || json.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(json)
    return {
      routingPolicyVersion: parsed.routingPolicyVersion,
      weightsVersion: parsed.weightsVersion,
      routingPolicyFingerprints: parsed.routingPolicyFingerprints ?? {},
      weightsFingerprints: parsed.weightsFingerprints ?? {},
    }
  } catch (err) {
    throw new Error(`Invalid fingerprint manifest JSON: ${err.message}`)
  }
}

/** Read the current working-tree manifest file. */
function readWorkingTreeManifest() {
  const path = join(REPO_ROOT, MANIFEST_PATH)
  if (!existsSync(path)) return undefined
  return parseManifest(readFileSync(path, "utf8"))
}

/** Compute the live fingerprint report via the bun entry point. */
function computeLiveReport() {
  const entry = join(REPO_ROOT, REPORT_ENTRY)
  const proc = spawnSync(getBunExecutable(), ["run", entry], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (proc.status !== 0) {
    const tail = (proc.stderr || proc.stdout || "no output").toString().slice(-2000)
    throw new Error(`Fingerprint report failed (exit ${proc.status}):\n${tail}`)
  }
  const stdout = proc.stdout.toString()
  const lines = stdout.trim().split("\n")
  const jsonLine = lines[lines.length - 1]
  try {
    return JSON.parse(jsonLine)
  } catch (err) {
    throw new Error(`Fingerprint report produced invalid JSON on its final line: ${err.message}`)
  }
}

/** Parse CLI args: --base <sha> --head <sha>. */
function parseArgs(argv) {
  const args = { base: undefined, head: "HEAD" }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) {
      args.base = argv[i + 1]
      i += 1
    } else if (argv[i] === "--head" && argv[i + 1]) {
      args.head = argv[i + 1]
      i += 1
    }
  }
  return args
}

/**
 * Validate the routing policy / weights version contract between the
 * merge-base manifest and the current branch manifest against the live
 * fingerprint report. Returns a list of violation messages (empty = pass).
 */
export function validatePolicyVersionGate({ baseManifest, headManifest, liveReport }) {
  const problems = []

  if (baseManifest === undefined && headManifest === undefined) {
    return ["No fingerprint manifest found in the base or current branch"]
  }

  // 1. Diff-based immutability: an existing registered historical fingerprint
  //    must never be modified between base and head.
  const basePolicy = baseManifest?.routingPolicyFingerprints ?? {}
  const headPolicy = headManifest?.routingPolicyFingerprints ?? {}
  const baseWeights = baseManifest?.weightsFingerprints ?? {}
  const headWeights = headManifest?.weightsFingerprints ?? {}

  for (const [version, fp] of Object.entries(basePolicy)) {
    if (headPolicy[version] !== undefined && headPolicy[version] !== fp) {
      problems.push(
        `Registered routing policy fingerprint for version ${version} was modified ` +
          `(${fp} → ${headPolicy[version]}). Registered fingerprints are immutable.`,
      )
    }
  }
  for (const [version, fp] of Object.entries(baseWeights)) {
    if (headWeights[version] !== undefined && headWeights[version] !== fp) {
      problems.push(
        `Registered weights fingerprint for version ${version} was modified ` +
          `(${fp} → ${headWeights[version]}). Registered fingerprints are immutable.`,
      )
    }
  }

  // 2. Current version must be registered in the head manifest.
  if (headManifest === undefined) {
    problems.push("Fingerprint manifest is missing on the current branch")
  } else {
    const policyRegistered = headManifest.routingPolicyFingerprints[liveReport.policyVersion]
    const weightsRegistered = headManifest.weightsFingerprints[liveReport.weightsVersion]

    if (policyRegistered === undefined) {
      problems.push(
        `Routing policy version ${liveReport.policyVersion} is missing from the manifest. ` +
          `A version bump requires registering its fingerprint: ` +
          `node scripts/update-routing-fingerprints.mjs`,
      )
    } else if (policyRegistered !== liveReport.policyFingerprint) {
      problems.push(
        `Routing policy fingerprint changed without a version bump: live=${liveReport.policyFingerprint}, ` +
          `registered=${policyRegistered} for version ${liveReport.policyVersion}. ` +
          `Bump ROUTING_POLICY_VERSION and re-run the update script.`,
      )
    }

    if (weightsRegistered === undefined) {
      problems.push(
        `Weights version ${liveReport.weightsVersion} is missing from the manifest. ` +
          `A version bump requires registering its fingerprint: ` +
          `node scripts/update-routing-fingerprints.mjs`,
      )
    } else if (weightsRegistered !== liveReport.weightsFingerprint) {
      problems.push(
        `Weights fingerprint changed without a version bump: live=${liveReport.weightsFingerprint}, ` +
          `registered=${weightsRegistered} for version ${liveReport.weightsVersion}. ` +
          `Bump ROUTING_WEIGHTS_VERSION and re-run the update script.`,
      )
    }
  }

  // 3. Version continuity: head version must equal or exceed base version.
  if (baseManifest !== undefined && headManifest !== undefined) {
    const compareSemver = (a, b) => {
      const pa = String(a).split(".").map((n) => Number(n) || 0)
      const pb = String(b).split(".").map((n) => Number(n) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const da = pa[i] ?? 0
        const db = pb[i] ?? 0
        if (da !== db) return da < db ? -1 : 1
      }
      return 0
    }
    if (compareSemver(headManifest.routingPolicyVersion, baseManifest.routingPolicyVersion) < 0) {
      problems.push(
        `Routing policy version regressed: base ${baseManifest.routingPolicyVersion} → ` +
          `head ${headManifest.routingPolicyVersion}. Versions must be monotonic.`,
      )
    }
    if (compareSemver(headManifest.weightsVersion, baseManifest.weightsVersion) < 0) {
      problems.push(
        `Weights version regressed: base ${baseManifest.weightsVersion} → ` +
          `head ${headManifest.weightsVersion}. Versions must be monotonic.`,
      )
    }
  }

  return problems
}

/** CLI entry point. */
export function runPolicyVersionGate({ base, head }) {
  const liveReport = computeLiveReport()

  const baseJson = base === undefined ? undefined : gitShowFile(base, MANIFEST_PATH)
  const headJson = head === "HEAD" ? undefined : gitShowFile(head, MANIFEST_PATH)
  const baseManifest = parseManifest(baseJson)
  const headManifest = head === "HEAD" ? readWorkingTreeManifest() : parseManifest(headJson)

  const problems = validatePolicyVersionGate({ baseManifest, headManifest, liveReport })

  console.log(
    `Live routing policy fingerprint: ${liveReport.policyFingerprint} (version ${liveReport.policyVersion})`,
  )
  console.log(
    `Live weights fingerprint: ${liveReport.weightsFingerprint} (version ${liveReport.weightsVersion})`,
  )
  console.log(`Base manifest: ${baseManifest ? `present (${base})` : "absent"}`)
  console.log(`Head manifest: ${headManifest ? "present" : "absent"}`)

  if (problems.length > 0) {
    console.error("\nROUTING POLICY VERSION GATE FAILED:")
    for (const problem of problems) {
      console.error(`  - ${problem}`)
    }
    process.exitCode = 1
    return { ok: false, problems, liveReport }
  }

  console.log("\nRouting policy version gate passed: all version-governed values are registered.")
  return { ok: true, problems, liveReport }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.base === undefined) {
      // Auto-detect the merge-base for CI: origin/main (or main), falling
      // back to the previous commit when neither ref exists.
      const detect = spawnSync(
        "git",
        ["merge-base", "HEAD", "origin/main"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      )
      args.base = detect.status === 0 && detect.stdout ? detect.stdout.trim() : undefined
      if (args.base === undefined) {
        const fallback = spawnSync("git", ["merge-base", "HEAD", "main"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        })
        args.base = fallback.status === 0 && fallback.stdout ? fallback.stdout.trim() : undefined
      }
      if (args.base === undefined) {
        console.error(
          "No base ref provided and auto-detection failed (origin/main and main unavailable). " +
            "Pass --base <sha> explicitly.",
        )
        process.exit(2)
      }
    }
    const result = runPolicyVersionGate(args)
    if (!result.ok) process.exit(1)
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    process.exit(1)
  }
}

