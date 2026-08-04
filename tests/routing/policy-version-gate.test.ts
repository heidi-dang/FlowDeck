/**
 * Policy-version gate — adversarial regression matrix.
 *
 * Locks down the contract of scripts/check-routing-policy-version.mjs:
 * every change to a version-governed routing policy value or scoring weight
 * must be accompanied by a version bump + fingerprint registration. The gate
 * is diff-based (base manifest vs head manifest) and hashes LIVE canonical
 * values, so it cannot be satisfied by editing fixtures.
 *
 * The script itself is FINAL (already repaired and independently verified).
 * This file is the permanent regression net over its exported pure functions
 * (`parseStrictSemver`, `compareStrictSemver`, `validatePolicyVersionGate`)
 * and over the CLI entry point invoked via `bun`.
 *
 * The pure validator takes a manifest pair + live report:
 *   manifest: { routingPolicyVersion, weightsVersion,
 *               routingPolicyFingerprints: Record<string,string>,
 *               weightsFingerprints: Record<string,string> }
 *   live:     { policyVersion, weightsVersion, policyFingerprint,
 *               weightsFingerprint }
 *
 * Assertions use keyword matches (not exact strings) so the matrix survives
 * message wording changes while still pinning the gate's behavior.
 */

import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  parseStrictSemver,
  compareStrictSemver,
  validatePolicyVersionGate,
} from "../../scripts/check-routing-policy-version.mjs"

// ─── Fixtures ───────────────────────────────────────────────────────────

/** Real-looking 64-hex-char fingerprint, distinct per id. */
function fp(id: number): string {
  return id.toString(16).padStart(64, "0")
}

/** A valid manifest whose current version matches mkLive() by default. */
function mkManifest(over: Record<string, unknown> = {}) {
  return {
    routingPolicyVersion: "1.0.0",
    weightsVersion: "1.0.0",
    routingPolicyFingerprints: { "1.0.0": fp(1) },
    weightsFingerprints: { "1.0.0": fp(2) },
    ...over,
  }
}

/** A live report consistent with the default mkManifest(). */
function mkLive(over: Record<string, unknown> = {}) {
  return {
    policyVersion: "1.0.0",
    weightsVersion: "1.0.0",
    policyFingerprint: fp(1),
    weightsFingerprint: fp(2),
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. parseStrictSemver
// ─────────────────────────────────────────────────────────────────────────
describe("parseStrictSemver", () => {
  it("should parse a valid triple into numeric [major, minor, patch]", () => {
    expect(parseStrictSemver("1.0.0")).toEqual([1, 0, 0])
    expect(parseStrictSemver("2.3.4")).toEqual([2, 3, 4])
  })

  it("should parse zero and multi-digit segments", () => {
    expect(parseStrictSemver("0.0.0")).toEqual([0, 0, 0])
    expect(parseStrictSemver("10.20.30")).toEqual([10, 20, 30])
  })

  it("should reject non-string input (number, undefined, null)", () => {
    expect(parseStrictSemver(123 as never)).toBeNull()
    expect(parseStrictSemver(undefined as never)).toBeNull()
    expect(parseStrictSemver(null as never)).toBeNull()
  })

  it("should reject missing segments", () => {
    for (const value of ["1.0", "1", "1..0"]) {
      expect(parseStrictSemver(value), `"${value}" must be rejected`).toBeNull()
    }
  })

  it("should reject extra segments", () => {
    expect(parseStrictSemver("1.0.0.1")).toBeNull()
  })

  it("should reject leading zeros", () => {
    for (const value of ["01.0.0", "1.00.0", "1.0.01"]) {
      expect(parseStrictSemver(value), `"${value}" must be rejected`).toBeNull()
    }
  })

  it("should reject letters", () => {
    for (const value of ["1.0.x", "a.b.c"]) {
      expect(parseStrictSemver(value), `"${value}" must be rejected`).toBeNull()
    }
  })

  it("should reject prerelease and build metadata", () => {
    for (const value of ["1.0.0-alpha", "1.0.0+build"]) {
      expect(parseStrictSemver(value), `"${value}" must be rejected`).toBeNull()
    }
  })

  it("should reject the empty string", () => {
    expect(parseStrictSemver("")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. compareStrictSemver
// ─────────────────────────────────────────────────────────────────────────
describe("compareStrictSemver", () => {
  it("should return -1, 0, or 1 for valid ordered triples", () => {
    expect(compareStrictSemver("1.0.0", "2.0.0")).toBe(-1)
    expect(compareStrictSemver("0.9.9", "1.0.0")).toBe(-1)
    expect(compareStrictSemver("2.0.0", "1.0.0")).toBe(1)
    expect(compareStrictSemver("1.2.3", "1.2.3")).toBe(0)
    expect(compareStrictSemver("1.2.3", "1.2.4")).toBe(-1)
    expect(compareStrictSemver("1.3.0", "1.2.4")).toBe(1)
  })

  it("should return null when either input is invalid", () => {
    expect(compareStrictSemver("1.0", "1.0.0")).toBeNull()
    expect(compareStrictSemver("1.0.0", "v1.0.0")).toBeNull()
    expect(compareStrictSemver("01.0.0", "1.0.0")).toBeNull()
    expect(compareStrictSemver("1.0.0", "not-a-version")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. validatePolicyVersionGate
// ─────────────────────────────────────────────────────────────────────────
describe("validatePolicyVersionGate", () => {
  it("should pass when the base manifest is absent and head matches live", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: mkManifest(),
      liveReport: mkLive(),
    })
    expect(problems).toEqual([])
  })

  it("should pass when base and head are identical and match live", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: mkManifest(),
      headManifest: mkManifest(),
      liveReport: mkLive(),
    })
    expect(problems).toEqual([])
  })

  it("should reject deletion of a historical policy fingerprint", () => {
    const base = mkManifest({ routingPolicyFingerprints: { "0.9.0": fp(3), "1.0.0": fp(1) } })
    const head = mkManifest({ routingPolicyFingerprints: { "1.0.0": fp(1) } })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("deleted"))).toBe(true)
    expect(problems.some((p) => p.includes("0.9.0"))).toBe(true)
  })

  it("should reject deletion of a historical weights fingerprint", () => {
    const base = mkManifest({ weightsFingerprints: { "0.9.0": fp(5), "1.0.0": fp(2) } })
    const head = mkManifest({ weightsFingerprints: { "1.0.0": fp(2) } })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("deleted"))).toBe(true)
    expect(problems.some((p) => p.includes("0.9.0"))).toBe(true)
  })

  it("should reject modification of a historical policy fingerprint", () => {
    const base = mkManifest({ routingPolicyFingerprints: { "0.9.0": fp(3), "1.0.0": fp(1) } })
    const head = mkManifest({ routingPolicyFingerprints: { "0.9.0": fp(4), "1.0.0": fp(1) } })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("modified"))).toBe(true)
    expect(problems.some((p) => p.includes("0.9.0"))).toBe(true)
  })

  it("should reject modification of a historical weights fingerprint", () => {
    const base = mkManifest({ weightsFingerprints: { "0.9.0": fp(5), "1.0.0": fp(2) } })
    const head = mkManifest({ weightsFingerprints: { "0.9.0": fp(6), "1.0.0": fp(2) } })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("modified"))).toBe(true)
    expect(problems.some((p) => p.includes("0.9.0"))).toBe(true)
  })

  it("should reject when the current policy version is missing from the manifest", () => {
    const head = mkManifest({
      routingPolicyVersion: "1.1.0",
      routingPolicyFingerprints: { "1.0.0": fp(1) },
    })
    const problems = validatePolicyVersionGate({
      baseManifest: mkManifest(),
      headManifest: head,
      liveReport: mkLive({ policyVersion: "1.1.0", policyFingerprint: fp(7) }),
    })
    expect(problems.some((p) => p.includes("missing from the manifest"))).toBe(true)
  })

  it("should reject when the current weights version is missing from the manifest", () => {
    const head = mkManifest({
      weightsVersion: "1.1.0",
      weightsFingerprints: { "1.0.0": fp(2) },
    })
    const problems = validatePolicyVersionGate({
      baseManifest: mkManifest(),
      headManifest: head,
      liveReport: mkLive({ weightsVersion: "1.1.0", weightsFingerprint: fp(8) }),
    })
    expect(problems.some((p) => p.includes("missing from the manifest"))).toBe(true)
  })

  it("should reject when the live policy fingerprint differs from the registered one", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: mkManifest(),
      liveReport: mkLive({ policyFingerprint: fp(9) }),
    })
    expect(problems.some((p) => p.includes("changed without a version bump"))).toBe(true)
  })

  it("should reject when the live weights fingerprint differs from the registered one", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: mkManifest(),
      liveReport: mkLive({ weightsFingerprint: fp(10) }),
    })
    expect(problems.some((p) => p.includes("changed without a version bump"))).toBe(true)
  })

  it("should reject when the manifest routingPolicyVersion does not equal the live version", () => {
    const head = mkManifest({
      routingPolicyVersion: "1.1.0",
      routingPolicyFingerprints: { "1.0.0": fp(1), "1.1.0": fp(11) },
    })
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: head,
      liveReport: mkLive(),
    })
    expect(problems.some((p) => p.includes("does not match the live version"))).toBe(true)
  })

  it("should reject when the manifest weightsVersion does not equal the live weights version", () => {
    const head = mkManifest({
      weightsVersion: "1.1.0",
      weightsFingerprints: { "1.0.0": fp(2), "1.1.0": fp(12) },
    })
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: head,
      liveReport: mkLive(),
    })
    expect(problems.some((p) => p.includes("does not match the live version"))).toBe(true)
  })

  it("should reject a policy version regression (head < base)", () => {
    const base = mkManifest({
      routingPolicyVersion: "1.1.0",
      routingPolicyFingerprints: { "1.0.0": fp(1), "1.1.0": fp(13) },
    })
    const head = mkManifest({
      routingPolicyVersion: "1.0.0",
      routingPolicyFingerprints: { "1.0.0": fp(1), "1.1.0": fp(13) },
    })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("regressed"))).toBe(true)
  })

  it("should reject a weights version regression", () => {
    const base = mkManifest({
      weightsVersion: "1.1.0",
      weightsFingerprints: { "1.0.0": fp(2), "1.1.0": fp(14) },
    })
    const head = mkManifest({
      weightsVersion: "1.0.0",
      weightsFingerprints: { "1.0.0": fp(2), "1.1.0": fp(14) },
    })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: mkLive() })
    expect(problems.some((p) => p.includes("regressed"))).toBe(true)
  })

  it("should reject invalid semver in routingPolicyVersion", () => {
    for (const invalid of ["1.0", "v1.0.0", "01.0.0", "1.0.0.1"]) {
      const head = mkManifest({
        routingPolicyVersion: invalid,
        routingPolicyFingerprints: { "1.0.0": fp(1) },
      })
      const problems = validatePolicyVersionGate({
        baseManifest: undefined,
        headManifest: head,
        liveReport: mkLive(),
      })
      expect(
        problems.some((p) => p.includes("Invalid semantic version")),
        `version "${invalid}" must be flagged`,
      ).toBe(true)
    }
  })

  it("should reject invalid semver in a fingerprint-map key", () => {
    const head = mkManifest({
      routingPolicyFingerprints: { "1.0": fp(15), "1.0.0": fp(16) },
    })
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: head,
      liveReport: mkLive({ policyFingerprint: fp(16) }),
    })
    expect(problems.some((p) => p.includes("Invalid semantic version"))).toBe(true)
  })

  it("should reject when no manifest exists in either base or head", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: undefined,
      headManifest: undefined,
      liveReport: mkLive(),
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("No fingerprint manifest")
  })

  it("should reject when the head manifest is missing entirely", () => {
    const problems = validatePolicyVersionGate({
      baseManifest: mkManifest(),
      headManifest: undefined,
      liveReport: mkLive(),
    })
    expect(problems.some((p) => p.includes("missing on the current branch"))).toBe(true)
  })

  it("should pass a legitimate version-bump flow (historical entries kept, new version registered)", () => {
    const base = mkManifest({
      routingPolicyVersion: "0.9.0",
      weightsVersion: "0.9.0",
      routingPolicyFingerprints: { "0.9.0": fp(1), "1.0.0": fp(2) },
      weightsFingerprints: { "0.9.0": fp(3), "1.0.0": fp(4) },
    })
    const head = mkManifest({
      routingPolicyVersion: "1.1.0",
      weightsVersion: "1.1.0",
      routingPolicyFingerprints: { "0.9.0": fp(1), "1.0.0": fp(2), "1.1.0": fp(5) },
      weightsFingerprints: { "0.9.0": fp(3), "1.0.0": fp(4), "1.1.0": fp(6) },
    })
    const live = mkLive({
      policyVersion: "1.1.0",
      weightsVersion: "1.1.0",
      policyFingerprint: fp(5),
      weightsFingerprint: fp(6),
    })
    const problems = validatePolicyVersionGate({ baseManifest: base, headManifest: head, liveReport: live })
    expect(problems).toEqual([])
  })

  it("should skip the regression check gracefully when invalid semver is already flagged", () => {
    const head = mkManifest({ routingPolicyVersion: "not-a-version", weightsVersion: "9.9" })
    const problems = validatePolicyVersionGate({
      baseManifest: mkManifest(),
      headManifest: head,
      liveReport: mkLive(),
    })
    // no crash, the invalid versions are flagged...
    expect(problems.some((p) => p.includes("Invalid semantic version"))).toBe(true)
    // ...and monotonic comparison never misfires on non-comparable versions
    expect(problems.some((p) => p.includes("regressed"))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. CLI integration (spawns the real script via bun)
// ─────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const GATE_SCRIPT = fileURLToPath(new URL("../../scripts/check-routing-policy-version.mjs", import.meta.url))
const MANIFEST_REL = "src/orchestration/routing/fingerprints.json"

function git(...args: string[]): string | undefined {
  const proc = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
  if (proc.status !== 0) return undefined
  return proc.stdout.trim()
}

function runGate(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("bun", [GATE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" }
}

const hasOriginMain = git("rev-parse", "--verify", "origin/main") !== undefined

/** Prefer the live merge-base; fall back to the known main HEAD literal, then HEAD~1. */
function resolveBaseSha(): string {
  const mergeBase = git("merge-base", "HEAD", "origin/main")
  if (mergeBase) return mergeBase
  // `^{commit}` forces object existence — a bare hex literal is echoed back by
  // rev-parse even when the commit is absent (e.g. a shallow checkout).
  const literal = git("rev-parse", "--verify", "5809fcf1230ff349ff0d7f5b53ed75403f44573b^{commit}")
  if (literal) return literal
  const parent = git("rev-parse", "HEAD~1")
  if (parent) return parent
  throw new Error("no resolvable base commit found in this environment")
}

/**
 * Best-effort resolvable base; undefined when the environment (e.g. a shallow
 * checkout with no origin/main, no known main HEAD, and no HEAD parent) cannot
 * provide one. History-dependent tests skip on undefined instead of throwing.
 */
function resolveBaseShaSafe(): string | undefined {
  try {
    return resolveBaseSha()
  } catch {
    return undefined
  }
}

/** True when the commit resolves and does not contain the manifest file. */
function isCommitWithoutManifest(sha: string): boolean {
  if (!git("rev-parse", "--verify", `${sha}^{commit}`)) return false
  return git("show", `${sha}:${MANIFEST_REL}`) === undefined
}

/**
 * Find a commit that predates the manifest, or undefined when the environment
 * cannot prove one exists. On a shallow checkout the shallow boundary commit
 * is reported as a "root" (and as the add commit for every path) but may
 * already contain the manifest, so every candidate is verified before being
 * trusted — an unverifiable environment yields undefined, never a wrong SHA.
 */
function findCommitWithoutManifest(): string | undefined {
  const addLines = git("log", "--diff-filter=A", "--format=%H", "--", MANIFEST_REL)
  const oldestAdd = addLines?.split("\n").filter(Boolean).pop()
  if (oldestAdd) {
    const parent = git("rev-parse", `${oldestAdd}^`)
    if (parent && isCommitWithoutManifest(parent)) return parent
  }
  const root = git("rev-list", "--max-parents=0", "HEAD")?.split("\n").filter(Boolean).pop()
  if (root && isCommitWithoutManifest(root)) return root
  return undefined
}

const safeBaseSha = resolveBaseShaSafe()
const beforeManifestSha = findCommitWithoutManifest()

describe("policy-version gate CLI integration", () => {
  it.skipIf(!safeBaseSha)("should exit 0 when the base resolves and the head manifest matches live", () => {
    const result = runGate(["--base", safeBaseSha as string, "--head", "HEAD"])
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain("passed")
  }, 120000)

  it("should exit 1 when the base cannot be resolved and mention the base in stderr", () => {
    const result = runGate(["--base", "0000000000000000000000000000000000000000", "--head", "HEAD"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/could not be resolved/i)
    expect(result.stderr).toMatch(/base/i)
  })

  it.skipIf(!hasOriginMain)("should exit 0 with no --base when auto-detection resolves origin/main", () => {
    const result = runGate(["--head", "HEAD"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Auto-detected base")
  }, 120000)

  it.skipIf(!safeBaseSha || !beforeManifestSha)(
    "should exit 1 when the head manifest is missing (base valid, head predates the manifest)",
    () => {
      const result = runGate(["--base", safeBaseSha as string, "--head", beforeManifestSha as string])
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toMatch(/missing on the current branch|No fingerprint manifest/)
    },
    120000,
  )
})
