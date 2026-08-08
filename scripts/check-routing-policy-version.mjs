/**
 * Routing policy / weights version gate.
 *
 * Enforces that every change to a version-governed canonical routing policy
 * value or scoring weight is accompanied by a corresponding version increment
 * and fingerprint registration. The gate is diff-based: the base manifest (at
 * a resolvable base commit) is compared against the current branch manifest,
 * so a registered historical fingerprint can never be silently rewritten or
 * deleted, and the current version must always be present in the manifest with
 * a fingerprint equal to the LIVE hash of the canonical values.
 *
 * The check hashes live canonical values — it cannot be satisfied by editing
 * a fixture. When a version-governed policy value changes, the developer MUST
 * bump ROUTING_POLICY_VERSION (or ROUTING_WEIGHTS_VERSION) and re-run
 * `node scripts/update-routing-fingerprints.mjs` to register the new
 * fingerprint.
 *
 * The gate REQUIRES a resolvable base commit and NEVER passes head-only. In
 * CI, actions/checkout must fetch full history (fetch-depth: 0) and the exact
 * PR base SHA is passed via `--base <sha>`. Local runs (no --base) auto-detect
 * the base from origin/main, then main, then HEAD~1.
 *
 * Fails when:
 *   - the base commit cannot be resolved (an unresolvable --base, or
 *     auto-detection fails entirely);
 *   - the policy fingerprint changed without a routing policy version bump;
 *   - the weights fingerprint changed without a weights version bump;
 *   - a version changed without its fingerprint being registered;
 *   - the current version is missing from the manifest;
 *   - an existing registered historical fingerprint was modified or deleted;
 *   - the manifest current version differs from the live ROUTING_POLICY_VERSION
 *     / ROUTING_WEIGHTS_VERSION;
 *   - any version string in the manifests is not strict numeric major.minor.patch
 *     (no leading zeros, no prerelease/build metadata);
 *   - the head version regresses below the base version.
 *
 * Usage:
 *   node scripts/check-routing-policy-version.mjs --base <sha> --head HEAD
 *   node scripts/check-routing-policy-version.mjs --head HEAD  # auto-detect base
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

/**
 * Resolve a git ref to a commit SHA, or undefined when the ref does not
 * resolve to a commit (nonexistent ref, unborn branch, tree/blob object).
 */
function resolveCommit(ref) {
  const proc = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
  if (proc.status !== 0 || !proc.stdout) return undefined
  return proc.stdout.trim()
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

/**
 * Strictly parse a `major.minor.patch` version string: exactly three numeric
 * segments, no leading zeros, no prerelease/build metadata. Returns the
 * numeric triple, or null for anything else (non-string, missing/extra
 * segments, leading zeros, letters, empty segments).
 */
export function parseStrictSemver(value) {
  if (typeof value !== "string") return null
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (match === null) return null
  const segments = [match[1], match[2], match[3]]
  for (const segment of segments) {
    if (segment.length > 1 && segment.startsWith("0")) return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two strict semver triples numerically. Returns null when either
 * value fails parseStrictSemver, -1/0/1 otherwise.
 */
export function compareStrictSemver(a, b) {
  const pa = parseStrictSemver(a)
  const pb = parseStrictSemver(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
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
 * base manifest and the current branch manifest against the live
 * fingerprint report. Returns a list of violation messages (empty = pass).
 */
export function validatePolicyVersionGate({ baseManifest, headManifest, liveReport }) {
  const problems = []

  if (baseManifest === undefined && headManifest === undefined) {
    return ["No fingerprint manifest found in the base or current branch"]
  }

  // 1. Strict semver: every version string in either manifest must be a valid
  //    numeric major.minor.patch triple without leading zeros.
  const versionValues = []
  for (const manifest of [baseManifest, headManifest]) {
    if (manifest === undefined) continue
    versionValues.push(manifest.routingPolicyVersion, manifest.weightsVersion)
    for (const version of Object.keys(manifest.routingPolicyFingerprints)) versionValues.push(version)
    for (const version of Object.keys(manifest.weightsFingerprints)) versionValues.push(version)
  }
  for (const value of versionValues) {
    if (parseStrictSemver(value) === null) {
      problems.push(
        `Invalid semantic version "${value}" in fingerprint manifest. Versions must be numeric major.minor.patch without leading zeros.`,
      )
    }
  }

  // 2. Diff-based immutability: an existing registered historical fingerprint
  //    must never be modified or deleted between base and head.
  const basePolicy = baseManifest?.routingPolicyFingerprints ?? {}
  const headPolicy = headManifest?.routingPolicyFingerprints ?? {}
  const baseWeights = baseManifest?.weightsFingerprints ?? {}
  const headWeights = headManifest?.weightsFingerprints ?? {}

  for (const [version, fp] of Object.entries(basePolicy)) {
    if (headPolicy[version] === undefined) {
      problems.push(
        `Registered routing policy fingerprint for version ${version} was deleted. Registered fingerprints are immutable.`,
      )
    } else if (headPolicy[version] !== fp) {
      problems.push(
        `Registered routing policy fingerprint for version ${version} was modified ` +
          `(${fp} → ${headPolicy[version]}). Registered fingerprints are immutable.`,
      )
    }
  }
  for (const [version, fp] of Object.entries(baseWeights)) {
    if (headWeights[version] === undefined) {
      problems.push(
        `Registered weights fingerprint for version ${version} was deleted. Registered fingerprints are immutable.`,
      )
    } else if (headWeights[version] !== fp) {
      problems.push(
        `Registered weights fingerprint for version ${version} was modified ` +
          `(${fp} → ${headWeights[version]}). Registered fingerprints are immutable.`,
      )
    }
  }

  // 3. Current version must be registered in the head manifest and equal the
  //    live version.
  if (headManifest === undefined) {
    problems.push("Fingerprint manifest is missing on the current branch")
  } else {
    if (headManifest.routingPolicyVersion !== liveReport.policyVersion) {
      problems.push(
        `Manifest routing policy version ${headManifest.routingPolicyVersion} does not match the live version ${liveReport.policyVersion}. The manifest current version must equal ROUTING_POLICY_VERSION.`,
      )
    }
    if (headManifest.weightsVersion !== liveReport.weightsVersion) {
      problems.push(
        `Manifest weights version ${headManifest.weightsVersion} does not match the live version ${liveReport.weightsVersion}. The manifest current version must equal ROUTING_WEIGHTS_VERSION.`,
      )
    }

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

  // 4. Version continuity: head version must equal or exceed base version.
  //    Skipped when either version fails strict semver — the invalid-version
  //    problem (1) already fired for that case.
  if (baseManifest !== undefined && headManifest !== undefined) {
    const policyCmp = compareStrictSemver(
      headManifest.routingPolicyVersion,
      baseManifest.routingPolicyVersion,
    )
    if (policyCmp !== null && policyCmp < 0) {
      problems.push(
        `Routing policy version regressed: base ${baseManifest.routingPolicyVersion} → ` +
          `head ${headManifest.routingPolicyVersion}. Versions must be monotonic.`,
      )
    }
    const weightsCmp = compareStrictSemver(headManifest.weightsVersion, baseManifest.weightsVersion)
    if (weightsCmp !== null && weightsCmp < 0) {
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

  // Resolve the base commit. An explicit --base that does not resolve is a
  // hard failure — the gate never passes head-only. Local runs auto-detect
  // from origin/main, then main, then HEAD~1.
  let resolvedBase
  if (base !== undefined) {
    resolvedBase = resolveCommit(base)
    if (resolvedBase === undefined) {
      throw new Error(
        `Base ref "${base}" could not be resolved to a commit. The gate requires the exact PR base SHA to be fetched (actions/checkout with fetch-depth: 0) and passed via --base.`,
      )
    }
  } else {
    for (const candidate of ["origin/main", "main", "HEAD~1"]) {
      const sha = resolveCommit(candidate)
      if (sha !== undefined) {
        resolvedBase = sha
        console.log(`Auto-detected base: ${candidate} (${sha})`)
        break
      }
    }
    if (resolvedBase === undefined) {
      throw new Error(
        "No --base provided and auto-detection failed (origin/main, main, and HEAD~1 all unresolvable). The policy-version gate requires a resolvable base commit; pass --base <sha> explicitly.",
      )
    }
  }

  const baseJson = gitShowFile(resolvedBase, MANIFEST_PATH)
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
  console.log(`Base manifest: ${baseManifest ? `present (${resolvedBase})` : "absent"}`)
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
    const result = runPolicyVersionGate(args)
    if (!result.ok) process.exit(1)
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    process.exit(1)
  }
}

