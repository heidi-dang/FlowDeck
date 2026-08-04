/**
 * FDX Shared Infrastructure
 *
 * Shared functions for all fdx-* tools: executable validation, argument validation,
 * git read-only policy enforcement, binary discovery, native fallbacks, and the
 * fdx subprocess runner.
 *
 * Extracted from fdx.ts to keep per-tool files focused.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants, promises as fsPromises, openSync, fstatSync, closeSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, rmSync } from "fs"
import { join, resolve, dirname, extname } from "path"
import { createHash, randomBytes } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  topicContextPath,
  topicDecisionsPath,
  appendWithLock,
  readOrMissing,
  clearFileWithLock,
} from "./planning-state-lib"
import { sourceCommitShaError } from "./fdx-commit-sha.mjs"
export { sourceCommitShaError }
export { redactSecrets, containsSecrets } from "../lib/secret-redaction"
export { codebaseDir } from "./planning-state-lib"

// ─── Security: Executable and argument validation ──────────────────────────

export const DEFAULT_EXECUTABLE_ALLOWLIST = [
  "fdx",
  "fdx.exe",
  "git",
  "npm",
  "bun",
  "vitest",
  "oxlint",
  "tsc",
  "node",
]

export const TEST_RUNNER_ALLOWLIST = ["cargo", "pytest", "jest", "vitest", "go", "rspec", "rails"]
export const LINTER_ALLOWLIST = ["ruff", "clippy", "tsc", "eslint", "biome", "golangci", "rubocop"]

/**
 * Validate that an executable name is in the allowlist.
 * Prevents execution of unauthorized commands or command injection via paths.
 */
export function validateExecutable(name: string, allowlist: string[] = DEFAULT_EXECUTABLE_ALLOWLIST): string {
  if (name.includes("\0")) {
    throw new Error(`Executable name contains NUL byte`)
  }
  if (existsSync(name)) {
    try {
      if (statSync(name).isFile()) {
        const basename = name.split(/[/\\]/).pop() ?? ""
        if (allowlist.some(a => a === basename)) {
          return name
        }
        throw new Error(
          `Executable path "${name}" resolves to "${basename}" which is not in the allowlist. ` +
          `Allowed: ${allowlist.join(", ")}`
        )
      }
    } catch (err: unknown) {
      if (err instanceof Error) throw err
    }
  }
  if (!allowlist.includes(name)) {
    throw new Error(`Executable "${name}" is not in the allowlist. Allowed: ${allowlist.join(", ")}`)
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`Executable name "${name}" contains path separators or invalid characters`)
  }
  return name
}

export interface ValidateArgsOptions {
  maxCount?: number
  maxLen?: number
  maxTotalLen?: number
}

const DEFAULT_MAX_ARG_COUNT = 100
const DEFAULT_MAX_ARG_LEN = 16_384
const DEFAULT_MAX_TOTAL_ARG_LEN = 65_536

export function validateArgs(args: string[], opts: ValidateArgsOptions = {}): string[] {
  const maxCount = opts.maxCount ?? DEFAULT_MAX_ARG_COUNT
  const maxLen = opts.maxLen ?? DEFAULT_MAX_ARG_LEN
  const maxTotalLen = opts.maxTotalLen ?? DEFAULT_MAX_TOTAL_ARG_LEN

  if (args.length > maxCount) {
    throw new Error(`Too many arguments: received ${args.length}, maximum allowed is ${maxCount}`)
  }

  let totalLen = 0
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new Error(`Argument "${arg.slice(0, 20)}" rejected: contains NUL byte`)
    }
    if (arg.length > maxLen) {
      throw new Error(`Argument length ${arg.length} exceeds maximum allowed length of ${maxLen}`)
    }
    totalLen += arg.length
  }

  if (totalLen > maxTotalLen) {
    throw new Error(`Combined argument length ${totalLen} exceeds maximum allowed total length of ${maxTotalLen}`)
  }

  return args
}

// ─── Git read-only policy ──────────────────────────────────────────────────

export const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame",
  "ls-files", "ls-tree", "rev-parse", "rev-list",
  "describe", "shortlog", "branch", "tag", "stash",
])

export function validateGitPolicy(subcommand: string, args: string[] = []): void {
  const sub = subcommand ? subcommand.trim() : ""
  if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) {
    throw new Error(
      `[FDX Git Policy] Subcommand "${sub}" is not permitted under read-only policy. ` +
      `Allowed: ${[...GIT_READONLY_SUBCOMMANDS].join(", ")}`
    )
  }

  for (const arg of args) {
    if (arg === "-c" || arg.startsWith("-c=") || arg.startsWith("-c ") || arg.startsWith("--config")) {
      for (const pat of ["core.pager", "sequence.editor", "core.editor", "alias", "diff.external"]) {
        if (arg.includes(pat)) {
          throw new Error(`[FDX Git Policy] Blocked config override "${arg}" under read-only policy.`)
        }
      }
    }
    if (arg === "--exec-path" || arg.startsWith("--exec-path=")) {
      throw new Error(`[FDX Git Policy] Blocked exec-path override "${arg}" under read-only policy.`)
    }
    if (arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv") {
      throw new Error(`[FDX Git Policy] Mutating/prohibited diff flag "${arg}" is prohibited under read-only policy.`)
    }
  }

  if (sub === "branch") {
    for (const arg of args) {
      if (/^-(?:d|D|m|M|c|C)/.test(arg) || /^--(?:delete|move|copy|edit-description)/.test(arg)) {
        throw new Error(`[FDX Git Policy] Mutating branch flag "${arg}" is prohibited under read-only policy.`)
      }
    }
    const hasListFlag = args.some(a =>
      a === "--list" || a === "-l" || a === "--show-current" || a === "-a" || a === "-r" || a === "--all" || a === "--remotes" || a.startsWith("--format")
    )
    const positional = args.filter(a => !a.startsWith("-"))
    if (positional.length > 0 && !hasListFlag) {
      throw new Error(`[FDX Git Policy] Prohibited branch modification attempt with argument "${positional[0]}".`)
    }
  }

  if (sub === "tag") {
    for (const arg of args) {
      if (/^-(?:d|D|a|s|f)/.test(arg) || /^--(?:delete|annotate|sign|force)/.test(arg)) {
        throw new Error(`[FDX Git Policy] Mutating tag flag "${arg}" is prohibited under read-only policy.`)
      }
    }
    const hasListFlag = args.some(a => a === "-l" || a === "--list" || a.startsWith("--format"))
    const positional = args.filter(a => !a.startsWith("-"))
    if (positional.length > 0 && !hasListFlag) {
      throw new Error(`[FDX Git Policy] Prohibited tag modification attempt with argument "${positional[0]}".`)
    }
  }

  if (sub === "stash") {
    const stashSub = args[0] ? args[0].trim() : ""
    if (stashSub !== "list" && stashSub !== "show") {
      throw new Error(`[FDX Git Policy] Stash operation "${stashSub || "default (push)"}" is prohibited. Only "stash list" and "stash show" are allowed under read-only policy.`)
    }
  }
}

// ─── Binary discovery and caching ──────────────────────────────────────────

let activeProjectDir = process.cwd()

export function setActiveProjectDir(dir: string): void {
  activeProjectDir = dir
  // The resolution cache is keyed on the caller project directory: switching
  // the active project must never serve a resolution computed for a different
  // caller context (P1-2: cache-gating bypass).
  fdxCacheKey = null
  fdxCacheValue = null
}

export const MINIMUM_SUPPORTED_FDX_VERSION = "1.0.0"
export const MAXIMUM_SUPPORTED_FDX_MAJOR = 1
export const EXPECTED_FDX_PROTOCOL_VERSION = "1.0.0"

let cachedPackageVersion: string | null = null

/**
 * Locate the installed @heidi-dang/flowdeck package manifest by walking up from
 * this module's location. Works from the repository source tree
 * (src/tools → repo root), the built bundle (dist/tools or dist/commands →
 * package root), and an installed npm package.
 */
function findFlowdeckPackageManifest(startDir: string): { version: string } | null {
  let dir = startDir
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown }
        if (pkg.name === "@heidi-dang/flowdeck" && typeof pkg.version === "string" && pkg.version.length > 0) {
          return { version: pkg.version }
        }
      } catch {
        // Malformed package.json — keep walking upward.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Canonical FlowDeck release version, derived from the installed
 * @heidi-dang/flowdeck package manifest (the repository root package.json when
 * running from the source tree). Production code never hardcodes the release
 * version; the package manifest is the single source of truth shared by the
 * runtime, build scripts, and CI workflows.
 */
export function getFlowdeckPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion
  const manifest = findFlowdeckPackageManifest(dirname(fileURLToPath(import.meta.url)))
  if (!manifest) {
    throw new Error(
      "Unable to determine the @heidi-dang/flowdeck package version: no package manifest found. " +
      "Reinstall FlowDeck or ensure package.json is present next to the installed package."
    )
  }
  cachedPackageVersion = manifest.version
  return manifest.version
}

export interface FdxTarget {
  platform: NodeJS.Platform;
  arch: string;
  libc?: "gnu" | "musl";
  packageName: string;
  executableName: "fdx" | "fdx.exe";
}

export interface FdxProvenance {
  packageName: string;
  packageVersion: string;
  flowdeckVersion: string;
  fdxBinaryVersion: string;
  fdxProtocolVersion: string;
  targetTriple: string;
  platform: string;
  architecture: string;
  libc?: string;
  binaryFilename: string;
  binaryByteSize: number;
  sha256: string;
  sourceCommitSha?: string;
  cargoLockSha256?: string;
  rustcVersion?: string;
  buildProfile?: string;
  workflowRunId?: string;
  buildTimestamp?: string;
}

export interface FdxIntegrityResult {
  status: "pass" | "fail";
  checksumStatus: "pass" | "fail" | "missing" | "unverified";
  checksumMatch: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  provenanceValid: boolean;
  reason?: string;
}

export interface FdxResolutionResult {
  available: boolean;
  binary: string | null;
  binaryPath: string | null;
  message: string;
  source: "env" | "package" | "cache" | "path" | "none";
  target: FdxTarget | null;
  targetSupported: boolean;
  packagePresent: boolean;
  binaryPresent: boolean;
  binaryIntegrity: "pass" | "fail" | "unverified";
  binaryVersion: string | null;
  versionCompatible: boolean;
  checksumStatus: "pass" | "fail" | "missing" | "unverified";
  executionStatus: "pass" | "fail" | "unverified";
  fallbackAvailable: boolean;
  diagnostics: string[];
  repairCommand?: string;
  /**
   * The SHA-256 of the exact bytes that passed the trust contract during
   * validation. The resolver never re-reads the path to compute a fresh
   * digest after validation (P1-1): this is the digest the execution path
   * must match.
   */
  validatedSha256?: string | null;
}

export const STRICT_SEMVER_REGEX = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export function isSemverCompatible(version: string | null): { compatible: boolean; reason?: string } {
  if (!version) return { compatible: false, reason: "Missing version string" }
  const trimmed = version.trim()
  const match = trimmed.match(STRICT_SEMVER_REGEX)
  if (!match) return { compatible: false, reason: `Malformed semver version "${version}"` }

  const major = parseInt(match[1], 10)
  const minMajor = parseInt(MINIMUM_SUPPORTED_FDX_VERSION, 10) || 1
  if (major < minMajor) {
    return { compatible: false, reason: `Version v${trimmed} is below minimum supported v${MINIMUM_SUPPORTED_FDX_VERSION}` }
  }
  if (major > MAXIMUM_SUPPORTED_FDX_MAJOR) {
    return { compatible: false, reason: `Major version v${major} exceeds maximum supported v${MAXIMUM_SUPPORTED_FDX_MAJOR}` }
  }
  return { compatible: true }
}

export function validateFdxProvenance(
  provenance: any,
  target?: FdxTarget | null
): { valid: boolean; reason?: string } {
  if (!provenance || typeof provenance !== "object") {
    return { valid: false, reason: "Provenance manifest is missing or non-object" }
  }

  const requiredFields = [
    "packageName", "packageVersion", "flowdeckVersion",
    "fdxBinaryVersion", "fdxProtocolVersion", "targetTriple",
    "platform", "architecture", "binaryFilename", "binaryByteSize",
    "sha256", "buildProfile", "buildTimestamp"
  ]

  for (const field of requiredFields) {
    if (provenance[field] === undefined || provenance[field] === null || provenance[field] === "") {
      return { valid: false, reason: `Provenance missing mandatory field "${field}"` }
    }
  }

  // P2-2: binaryByteSize must be a non-negative safe integer. A string,
  // fractional, negative, NaN, or unsafe-integer value is a malformed
  // provenance contract and must fail closed — never silently pass the
  // required-field presence check and bypass the size comparison.
  if (!Number.isSafeInteger(provenance.binaryByteSize) || provenance.binaryByteSize < 0) {
    return { valid: false, reason: `Provenance binaryByteSize ${JSON.stringify(provenance.binaryByteSize)} is not a non-negative safe integer` }
  }

  if (target) {
    if (provenance.packageName !== target.packageName) {
      return { valid: false, reason: `Provenance packageName "${provenance.packageName}" mismatch with target "${target.packageName}"` }
    }
    if (provenance.binaryFilename !== target.executableName) {
      return { valid: false, reason: `Provenance binaryFilename "${provenance.binaryFilename}" mismatch with target executable "${target.executableName}"` }
    }

    // Full trust contract: every trust-critical field must match the expected
    // provenance exactly. Checksum success never outweighs a provenance
    // violation on a managed source.
    const expected = buildExpectedProvenance(target)

    if (expected.targetTriple && provenance.targetTriple !== expected.targetTriple) {
      return { valid: false, reason: `Provenance targetTriple "${provenance.targetTriple}" mismatch with expected "${expected.targetTriple}" for target ${targetNameOf(target)}` }
    }

    if (String(provenance.platform).toLowerCase() !== expected.platform) {
      return { valid: false, reason: `Provenance platform "${provenance.platform}" mismatch with expected "${expected.platform}"` }
    }

    const archTokens = String(provenance.architecture ?? "").split(/[-_]/).filter(Boolean)
    if (!archTokens.includes(target.arch)) {
      return { valid: false, reason: `Provenance architecture "${provenance.architecture}" does not identify ${target.arch}` }
    }

    if (expected.libc && provenance.libc !== undefined && provenance.libc !== expected.libc) {
      return { valid: false, reason: `Provenance libc "${provenance.libc}" mismatch with expected "${expected.libc}"` }
    }

    if (provenance.buildProfile !== "release") {
      return { valid: false, reason: `Provenance buildProfile "${provenance.buildProfile}" is not "release"` }
    }

    if (provenance.fdxProtocolVersion !== EXPECTED_FDX_PROTOCOL_VERSION) {
      return { valid: false, reason: `Provenance fdxProtocolVersion "${provenance.fdxProtocolVersion}" does not match expected "${EXPECTED_FDX_PROTOCOL_VERSION}"` }
    }

    const flowVer = isSemverCompatible(provenance.flowdeckVersion)
    if (!flowVer.compatible) {
      return { valid: false, reason: `Provenance flowdeckVersion invalid: ${flowVer.reason}` }
    }
    if (provenance.flowdeckVersion !== provenance.fdxBinaryVersion) {
      return { valid: false, reason: `Provenance flowdeckVersion "${provenance.flowdeckVersion}" does not match fdxBinaryVersion "${provenance.fdxBinaryVersion}"` }
    }
    const pkgVer = isSemverCompatible(provenance.packageVersion)
    if (!pkgVer.compatible) {
      return { valid: false, reason: `Provenance packageVersion invalid: ${pkgVer.reason}` }
    }

    // P2-1: version bindings. The provenance's package and FlowDeck versions
    // must equal the canonical FlowDeck version the binary was built for, and
    // the declared binary version must equal the package version. This closes
    // the gap where a provenance claiming an unrelated (but semver-valid)
    // version could pass validation.
    let canonicalVersion: string
    try {
      canonicalVersion = getFlowdeckPackageVersion()
    } catch {
      return { valid: false, reason: "Provenance version binding unverifiable: cannot determine canonical FlowDeck version" }
    }
    if (provenance.packageVersion !== canonicalVersion) {
      return { valid: false, reason: `Provenance packageVersion "${provenance.packageVersion}" does not match canonical FlowDeck version "${canonicalVersion}"` }
    }
    if (provenance.flowdeckVersion !== canonicalVersion) {
      return { valid: false, reason: `Provenance flowdeckVersion "${provenance.flowdeckVersion}" does not match canonical FlowDeck version "${canonicalVersion}"` }
    }

    // P2-3: the source commit must be a real, non-fabricated SHA — exactly 40
    // hex characters and not an all-zero/placeholder value. Shares the
    // canonical validator with the build and verify paths.
    const commitError = sourceCommitShaError(provenance.sourceCommitSha)
    if (commitError) {
      return { valid: false, reason: `Provenance ${commitError}` }
    }
  } else if (provenance.sourceCommitSha && sourceCommitShaError(provenance.sourceCommitSha)) {
    return { valid: false, reason: `Provenance ${sourceCommitShaError(provenance.sourceCommitSha)}` }
  }

  return { valid: true }
}

export function detectFdxTarget(): FdxTarget | null {
  const platform = process.platform
  const arch = process.arch

  let libc: "gnu" | "musl" | undefined
  if (platform === "linux") {
    let isMusl = false
    try {
      if (
        existsSync("/etc/alpine-release") ||
        existsSync("/lib/ld-musl-x86_64.so.1") ||
        existsSync("/lib/ld-musl-aarch64.so.1")
      ) {
        isMusl = true
      } else {
        const report: any = (process as any).report?.getReport?.()
        if (report && report.header && report.header.glibcVersionRuntime === undefined) {
          isMusl = true
        }
      }
    } catch {}
    libc = isMusl ? "musl" : "gnu"
  }

  if (platform === "linux" && arch === "x64" && libc === "gnu") {
    return { platform, arch, libc, packageName: "@heidi-dang/flowdeck-fdx-linux-x64-gnu", executableName: "fdx" }
  }
  if (platform === "linux" && arch === "arm64" && libc === "gnu") {
    return { platform, arch, libc, packageName: "@heidi-dang/flowdeck-fdx-linux-arm64-gnu", executableName: "fdx" }
  }
  if (platform === "linux" && arch === "x64" && libc === "musl") {
    return { platform, arch, libc, packageName: "@heidi-dang/flowdeck-fdx-linux-x64-musl", executableName: "fdx" }
  }
  if (platform === "darwin" && arch === "x64") {
    return { platform, arch, packageName: "@heidi-dang/flowdeck-fdx-darwin-x64", executableName: "fdx" }
  }
  if (platform === "darwin" && arch === "arm64") {
    return { platform, arch, packageName: "@heidi-dang/flowdeck-fdx-darwin-arm64", executableName: "fdx" }
  }
  if (platform === "win32" && arch === "x64") {
    return { platform, arch, packageName: "@heidi-dang/flowdeck-fdx-win32-x64", executableName: "fdx.exe" }
  }

  return null
}

/** Canonical target key (mirrors the cache directory naming convention). */
export function targetNameOf(target: FdxTarget): string {
  return `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`
}

/**
 * Canonical Rust target triples per platform target. These match the triples
 * emitted by the production CI build (.github/workflows/build-fdx-binaries.yml)
 * and the local packaging script; targetTriple in provenance.json must equal
 * them exactly.
 */
export const FDX_TARGET_TRIPLES: Record<string, string> = {
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-x64-musl": "x86_64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
}

/** The canonical target triple for a platform target, or null if unsupported. */
export function expectedTargetTriple(target: FdxTarget): string | null {
  return FDX_TARGET_TRIPLES[targetNameOf(target)] ?? null
}

/**
 * The exact provenance contract a managed FDX source must satisfy. Every field
 * is enforced by validateFdxProvenance when a target is supplied.
 */
export function buildExpectedProvenance(target: FdxTarget): {
  packageName: string
  binaryFilename: string
  targetTriple: string | null
  platform: string
  architecture: string
  libc?: string
  buildProfile: "release"
} {
  return {
    packageName: target.packageName,
    binaryFilename: target.executableName,
    targetTriple: expectedTargetTriple(target),
    platform: target.platform,
    architecture: target.arch,
    ...(target.libc ? { libc: target.libc } : {}),
    buildProfile: "release",
  }
}

export function getFdxCacheDir(target: FdxTarget, version = getFlowdeckPackageVersion()): string {
  const targetName = targetNameOf(target)
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "flowdeck", "fdx", version, targetName)
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || homedir(), "flowdeck", "cache", "fdx", version, targetName)
  }
  return join(homedir(), ".cache", "flowdeck", "fdx", version, targetName)
}

export interface FdxBinaryValidateOpts {
  requireChecksum?: boolean
  /** Managed sources must carry a provenance.json that satisfies the full contract. */
  requireProvenance?: boolean
  /** When supplied, provenance is validated against this exact target contract. */
  target?: FdxTarget | null
}

export function validateFdxBinaryPath(binPath: string, expectedDir?: string, requireManagedChecksum: boolean | FdxBinaryValidateOpts = false): {
  valid: boolean;
  version: string | null;
  versionCompatible: boolean;
  checksumStatus: "pass" | "fail" | "missing" | "unverified";
  integrity: FdxIntegrityResult;
  /** The SHA-256 of the exact bytes that passed the checksum contract (P1-1). */
  validatedSha256: string | null;
  reason?: string;
} {
  const opts: FdxBinaryValidateOpts = typeof requireManagedChecksum === "object"
    ? requireManagedChecksum
    : requireManagedChecksum ? { requireChecksum: true } : {}
  const requireChecksum = opts.requireChecksum ?? false
  const requireProvenance = opts.requireProvenance ?? false

  if (!existsSync(binPath)) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus: "missing",
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus: "missing", checksumMatch: false, provenanceValid: false, reason: "Binary file does not exist" },
      reason: "File does not exist",
    }
  }

  try {
    const st = statSync(binPath)
    if (!st.isFile()) {
      return {
        valid: false,
        version: null,
        versionCompatible: false,
        checksumStatus: "fail",
        validatedSha256: null,
        integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: "Path is not a regular file" },
        reason: "Path is a directory or not a regular file",
      }
    }
  } catch {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus: "fail",
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: "Cannot stat file" },
      reason: "Cannot stat file",
    }
  }

  if (process.platform !== "win32") {
    try {
      accessSync(binPath, constants.X_OK)
    } catch {
      return {
        valid: false,
        version: null,
        versionCompatible: false,
        checksumStatus: "fail",
        validatedSha256: null,
        integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: "Missing POSIX executable permission (X_OK)" },
        reason: "Missing POSIX executable permission (X_OK)",
      }
    }
  }

  const dir = expectedDir || dirname(binPath)
  const checksumPath = join(dir, "checksum.json")
  const provenancePath = join(dir, "provenance.json")

  let checksumStatus: "pass" | "fail" | "missing" | "unverified" = "unverified"
  let checksumMatch = false
  let expectedSha: string | undefined
  let actualSha: string | undefined
  let validatedSha: string | null = null
  let provenanceValid = false
  let hasProvenance = false
  let declaredFdxBinaryVersion: string | null = null

  if (existsSync(checksumPath) || existsSync(provenancePath)) {
    try {
      let manifest: any = {}
      if (existsSync(provenancePath)) {
        hasProvenance = true
        manifest = JSON.parse(readFileSync(provenancePath, "utf-8"))
        if (typeof manifest.fdxBinaryVersion === "string" && manifest.fdxBinaryVersion.length > 0) {
          declaredFdxBinaryVersion = manifest.fdxBinaryVersion
        }
        const provRes = validateFdxProvenance(manifest, opts.target ?? null)
        provenanceValid = provRes.valid
        if (!provRes.valid) {
          // A present-but-invalid provenance is a hard trust failure: checksum
          // success never outweighs a provenance violation on a managed source.
          return {
            valid: false,
            version: null,
            versionCompatible: false,
            checksumStatus: "fail",
            validatedSha256: null,
            integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: `Provenance validation failed: ${provRes.reason}` },
            reason: `Provenance validation failed: ${provRes.reason}`,
          }
        }
      }
      if (existsSync(checksumPath)) {
        const cManifest = JSON.parse(readFileSync(checksumPath, "utf-8"))
        manifest = { ...cManifest, ...manifest }
      }

      expectedSha = manifest.sha256 || manifest.checksum
      if (expectedSha) {
        // P1-1: the digest captured here comes from the EXACT bytes read for
        // the checksum comparison. This validated digest is what the resolver
        // must trust — never a later re-read of the path, which could observe
        // a different generation swapped in after validation.
        const fileBuf = readFileSync(binPath)
        actualSha = createHash("sha256").update(fileBuf).digest("hex")
        validatedSha = actualSha
        // P2-2: the provenance-declared binary byte size must be a non-negative
        // safe integer that exactly matches the actual file size. Any present
        // value that is not a valid size — or a size that differs from the
        // file — is a hard failure; a string/fractional/negative/NaN/unsafe
        // value must never bypass the size comparison.
        if (manifest.binaryByteSize !== undefined && !Number.isSafeInteger(manifest.binaryByteSize)) {
          return {
            valid: false,
            version: null,
            versionCompatible: false,
            checksumStatus: "fail",
            validatedSha256: null,
            integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, expectedSha256: expectedSha, actualSha256: actualSha, provenanceValid, reason: `Provenance binaryByteSize ${JSON.stringify(manifest.binaryByteSize)} is not a non-negative safe integer` },
            reason: `Provenance binaryByteSize ${JSON.stringify(manifest.binaryByteSize)} is not a non-negative safe integer`,
          }
        }
        if (manifest.binaryByteSize !== undefined && manifest.binaryByteSize !== fileBuf.length) {
          return {
            valid: false,
            version: null,
            versionCompatible: false,
            checksumStatus: "fail",
            validatedSha256: null,
            integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, expectedSha256: expectedSha, actualSha256: actualSha, provenanceValid, reason: `Provenance binaryByteSize ${manifest.binaryByteSize} does not match actual binary size ${fileBuf.length}` },
            reason: `Provenance binaryByteSize ${manifest.binaryByteSize} does not match actual binary size ${fileBuf.length}`,
          }
        }
        if (actualSha === expectedSha) {
          checksumStatus = "pass"
          checksumMatch = true
        } else {
          checksumStatus = "fail"
          checksumMatch = false
          validatedSha = null
          return {
            valid: false,
            version: null,
            versionCompatible: false,
            checksumStatus: "fail",
            validatedSha256: null,
            integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, expectedSha256: expectedSha, actualSha256: actualSha, provenanceValid, reason: `Checksum mismatch: expected ${expectedSha}, got ${actualSha}` },
            reason: `Checksum mismatch: expected ${expectedSha}, got ${actualSha}`,
          }
        }
      } else if (requireChecksum) {
        return {
          valid: false,
          version: null,
          versionCompatible: false,
          checksumStatus: "missing",
          validatedSha256: null,
          integrity: { status: "fail", checksumStatus: "missing", checksumMatch: false, provenanceValid: false, reason: "Checksum manifest missing sha256 field" },
          reason: "Checksum manifest missing sha256 field",
        }
      }
    } catch {
      return {
        valid: false,
        version: null,
        versionCompatible: false,
        checksumStatus: "fail",
        validatedSha256: null,
        integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: "Corrupt checksum/provenance manifest" },
        reason: "Corrupt checksum/provenance manifest",
      }
    }
  } else if (requireChecksum || requireProvenance) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus: requireChecksum ? "missing" : "unverified",
      validatedSha256: null,
      integrity: {
        status: "fail",
        checksumStatus: requireChecksum ? "missing" : "unverified",
        checksumMatch: false,
        provenanceValid: false,
        reason: requireProvenance ? "Managed source missing mandatory provenance.json" : "Managed source missing mandatory checksum.json",
      },
      reason: requireProvenance ? "Managed source missing mandatory provenance.json" : "Managed source missing mandatory checksum.json",
    }
  }

  let version: string | null = null
  try {
    // Contract 1: the --version probe runs from a private execution snapshot
    // of the EXACT bytes that passed the checksum/trust rules — never from the
    // candidate pathname (a replacement-before-probe cannot change what the
    // probe executes). For managed sources the pipeline verifies the opened
    // generation against the checksum digest before executing; for unmanaged
    // sources the opened generation is the one whose probe output is accepted.
    // The executed generation's digest becomes the authoritative validated
    // digest — captured BEFORE the probe runs (unmanaged trust order).
    const execRes = executeVerifiedSnapshot(binPath, ["--version"], validatedSha, { timeout: 3000 })
    if (execRes.kind === "executed") {
      const match = execRes.out.match(/fdx\s+v?([0-9]+\.[0-9]+\.[0-9]+)/i) || execRes.out.match(/v?([0-9]+\.[0-9]+\.[0-9]+)/)
      if (match && match[1]) {
        version = match[1]
      }
      validatedSha = execRes.sha256
    } else {
      return {
        valid: false,
        version: null,
        versionCompatible: false,
        checksumStatus,
        validatedSha256: null,
        integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid, reason: `Binary execution failed: ${execRes.reason}` },
        reason: `Binary execution failed: ${execRes.reason}`,
      }
    }
  } catch (err: any) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus,
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid, reason: `Binary execution failed: ${err.message}` },
      reason: `Binary execution failed: ${err.message}`,
    }
  }

  if (!version) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus,
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid, reason: "Binary returned malformed --version output" },
      reason: "Binary returned malformed --version output",
    }
  }

  const verCheck = isSemverCompatible(version)
  if (!verCheck.compatible) {
    return {
      valid: false,
      version,
      versionCompatible: false,
      checksumStatus,
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid, reason: verCheck.reason },
      reason: verCheck.reason,
    }
  }

  // P2-1: the provenance-declared binary version must equal the version the
  // binary actually reports. A provenance claiming a different binary version
  // than the one executing fails closed even when checksum and provenance
  // documents otherwise pass.
  if (hasProvenance && declaredFdxBinaryVersion !== null && declaredFdxBinaryVersion !== version) {
    return {
      valid: false,
      version,
      versionCompatible: false,
      checksumStatus,
      validatedSha256: null,
      integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid: false, reason: `Provenance fdxBinaryVersion "${declaredFdxBinaryVersion}" does not match executed binary version "${version}"` },
      reason: `Provenance fdxBinaryVersion "${declaredFdxBinaryVersion}" does not match executed binary version "${version}"`,
    }
  }

  return {
    valid: true,
    version,
    versionCompatible: true,
    checksumStatus,
    validatedSha256: validatedSha,
    integrity: {
      status: ((checksumStatus === "pass" || (!requireChecksum && checksumStatus === "unverified")) && (!hasProvenance || provenanceValid)) ? "pass" : "fail",
      checksumStatus,
      checksumMatch,
      expectedSha256: expectedSha,
      actualSha256: actualSha,
      provenanceValid,
    },
  }
}

/**
 * True when the runtime is a release profile, where untrusted local dev
 * sources must never be consulted — even with FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE set.
 */
export function isReleaseProfile(): boolean {
  return process.env.FLOWDECK_PROFILE === "release" || process.env.NODE_ENV === "production"
}

/**
 * Whether caller-controlled local dev sources (cwd/packages, cwd/node_modules,
 * active project node_modules) may be consulted for binary resolution.
 * Opt-in via FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE=1; default off; always
 * rejected in release profiles. FlowDeck's own resolved optional dependency
 * and the managed repair cache are trusted regardless of this flag.
 */
export function localDevSourcesAllowed(): boolean {
  if (isReleaseProfile()) return false
  return process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE === "1"
}

export interface ResolvedPlatformPackage {
  pkgDir: string
  source: "own" | "local-dev"
}

/**
 * Verify an actual package manifest, never directory-name resemblance.
 * Identity (exact name) and the canonical FlowDeck version are both required.
 */
function verifyPackageIdentity(pkgDir: string, expectedName: string, expectedVersion: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"))
    return pkg?.name === expectedName && pkg?.version === expectedVersion
  } catch {
    return false
  }
}

/**
 * Resolve FlowDeck's own installed optional dependency, anchored exclusively
 * to FlowDeck's own installed module location. The caller's project, cwd,
 * active project, and node_modules are never part of this resolution.
 */
function resolveOwnOptionalDependency(ownDir: string, target: FdxTarget, canonicalVersion: string): string | null {
  let pkgDir: string | null = null
  try {
    const req = createRequire(join(ownDir, "package.json"))
    const jsonPath = req.resolve(`${target.packageName}/package.json`)
    pkgDir = dirname(jsonPath)
  } catch {
    // Fall back to FlowDeck's own conventional node_modules layout. This path
    // lives inside FlowDeck's install tree and is not caller-influenced.
    const candidate = join(ownDir, "node_modules", target.packageName)
    if (existsSync(candidate)) pkgDir = candidate
  }
  if (!pkgDir || !existsSync(pkgDir)) return null
  if (!verifyPackageIdentity(pkgDir, target.packageName, canonicalVersion)) return null
  return pkgDir
}

/**
 * Resolve the platform package for `target` from trusted sources only.
 *
 * Trusted order:
 *  1. FlowDeck's own installed optional dependency — resolved via createRequire
 *     anchored exclusively to FlowDeck's own installed module location. The
 *     caller's project, its active project, its node_modules, and any other
 *     caller-influenced module search path are never part of this resolution.
 *  2. (opt-in only, never in release profiles) Caller-controlled local dev
 *     directories, discovered by direct path checks only (no module-resolution
 *     traversal): <dir>/node_modules/<pkg> and <dir>/packages/<localName>.
 *
 * Every candidate must pass exact package identity (name) and canonical
 * FlowDeck version verification before it is accepted; directory-name
 * resemblance alone is never trusted.
 */
export function resolveTrustedPlatformPackage(
  target: FdxTarget,
  opts: { includeLocalDev?: boolean } = {}
): ResolvedPlatformPackage | null {
  const ownDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const canonicalVersion = getFlowdeckPackageVersion()
  // Local dev sources are never consulted in release profiles, even when an
  // explicit includeLocalDev override is requested.
  const includeLocalDev = (opts.includeLocalDev ?? localDevSourcesAllowed()) && !isReleaseProfile()

  const ownCandidate = resolveOwnOptionalDependency(ownDir, target, canonicalVersion)
  if (ownCandidate) return { pkgDir: ownCandidate, source: "own" }

  if (includeLocalDev) {
    const devDirs = [activeProjectDir, process.cwd()]
    const seen = new Set<string>()
    for (const dir of devDirs) {
      const resolvedDir = resolve(dir)
      if (seen.has(resolvedDir)) continue
      seen.add(resolvedDir)
      const localName = target.packageName.replace("@heidi-dang/", "")
      for (const candidate of [
        join(resolvedDir, "node_modules", target.packageName),
        join(resolvedDir, "packages", localName),
      ]) {
        if (existsSync(candidate) && verifyPackageIdentity(candidate, target.packageName, canonicalVersion)) {
          return { pkgDir: candidate, source: "local-dev" }
        }
      }
    }
  }

  return null
}

export function resolveFdxBinaryPathDetailed(): FdxResolutionResult {
  const target = detectFdxTarget()
  const diagnostics: string[] = []
  const repairCommand = "npx flowdeck fdx repair"

  // 1. Explicit FDX_BINARY_PATH
  const envPath = process.env.FDX_BINARY_PATH
  if (envPath) {
    const resolvedEnv = resolve(envPath)
    const val = validateFdxBinaryPath(resolvedEnv)
    if (val.valid) {
      return {
        available: true,
        binary: resolvedEnv,
        binaryPath: resolvedEnv,
        message: `FDX native binary is available at "${resolvedEnv}".`,
        source: "env",
        target,
        targetSupported: target !== null,
        packagePresent: false,
        binaryPresent: true,
        binaryIntegrity: "pass",
        binaryVersion: val.version,
        versionCompatible: true,
        checksumStatus: val.checksumStatus,
        validatedSha256: val.validatedSha256,
        executionStatus: "pass",
        fallbackAvailable: true,
        diagnostics: [`Using environment binary from FDX_BINARY_PATH="${resolvedEnv}"`],
        repairCommand,
      }
    }
    diagnostics.push(`FDX_BINARY_PATH set to "${envPath}" but validation failed: ${val.reason}`)
    return {
      available: false,
      binary: null,
      binaryPath: null,
      message: `FDX_BINARY_PATH set to "${envPath}" but validation failed: ${val.reason}`,
      source: "env",
      target,
      targetSupported: target !== null,
      packagePresent: false,
      binaryPresent: false,
      binaryIntegrity: "fail",
      binaryVersion: null,
      versionCompatible: false,
      checksumStatus: val.checksumStatus,
      executionStatus: "fail",
      fallbackAvailable: true,
      diagnostics,
      repairCommand,
    }
  }

  // 2. Compatible FlowDeck platform package (trusted sources only)
  if (target) {
    const resolvedPkg = resolveTrustedPlatformPackage(target)
    if (resolvedPkg) {
      const binPath = join(resolvedPkg.pkgDir, target.executableName)
      const val = validateFdxBinaryPath(binPath, resolvedPkg.pkgDir, { requireChecksum: true, requireProvenance: true, target })
      if (val.valid) {
        return {
          available: true,
          binary: binPath,
          binaryPath: binPath,
          message: `FDX native binary is available at "${binPath}".`,
          source: "package",
          target,
          targetSupported: true,
          packagePresent: true,
          binaryPresent: true,
          binaryIntegrity: "pass",
          binaryVersion: val.version,
          versionCompatible: true,
          checksumStatus: val.checksumStatus,
          validatedSha256: val.validatedSha256,
          executionStatus: "pass",
          fallbackAvailable: true,
          diagnostics: [`Resolved compatible platform package binary at "${binPath}" (source: ${resolvedPkg.source})`],
          repairCommand,
        }
      }
      diagnostics.push(`Platform package "${target.packageName}" found at "${resolvedPkg.pkgDir}" (source: ${resolvedPkg.source}) but binary validation failed: ${val.reason}`)
    } else if (process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE === "1") {
      diagnostics.push(
        isReleaseProfile()
          ? `FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE is set but local dev sources are rejected (release profile: true). Ignoring caller project/node_modules directories.`
          : `Local dev sources are enabled but no platform package passed identity/version verification in the caller directories.`
      )
    }
  } else {
    diagnostics.push(`Platform target not supported for prebuilt binary distribution: ${process.platform}/${process.arch}`)
  }

  // 3. FlowDeck repair cache
  if (target) {
    const cacheDir = getFdxCacheDir(target)
    const cacheBin = join(cacheDir, target.executableName)
    if (existsSync(cacheBin)) {
      const val = validateFdxBinaryPath(cacheBin, cacheDir, { requireChecksum: true, requireProvenance: true, target })
      if (val.valid) {
        return {
          available: true,
          binary: cacheBin,
          binaryPath: cacheBin,
          message: `FDX native binary is available at "${cacheBin}".`,
          source: "cache",
          target,
          targetSupported: true,
          packagePresent: true,
          binaryPresent: true,
          binaryIntegrity: "pass",
          binaryVersion: val.version,
          versionCompatible: true,
          checksumStatus: val.checksumStatus,
          validatedSha256: val.validatedSha256,
          executionStatus: "pass",
          fallbackAvailable: true,
          diagnostics: [`Resolved repaired native binary from cache at "${cacheBin}"`],
          repairCommand,
        }
      }
      diagnostics.push(`Repair cache found at "${cacheBin}" but binary validation failed: ${val.reason}`)
    }
  }

  // 4. Compatible fdx binary from system PATH
  const pathEnv = process.env.PATH || ""
  const pathDirs = pathEnv.split(process.platform === "win32" ? ";" : ":").filter(Boolean)
  const execName = target ? target.executableName : (process.platform === "win32" ? "fdx.exe" : "fdx")

  for (const pathDir of pathDirs) {
    const pathBin = join(pathDir, execName)
    if (existsSync(pathBin)) {
      const val = validateFdxBinaryPath(pathBin)
      if (val.valid) {
        return {
          available: true,
          binary: pathBin,
          binaryPath: pathBin,
          message: `FDX native binary is available at "${pathBin}".`,
          source: "path",
          target,
          targetSupported: target !== null,
          packagePresent: false,
          binaryPresent: true,
          binaryIntegrity: "pass",
          binaryVersion: val.version,
          versionCompatible: true,
          checksumStatus: val.checksumStatus,
          validatedSha256: val.validatedSha256,
          executionStatus: "pass",
          fallbackAvailable: true,
          diagnostics: [`Resolved system PATH binary at "${pathBin}"`],
          repairCommand,
        }
      }
      diagnostics.push(`PATH candidate at "${pathBin}" rejected: ${val.reason}`)
    }
  }

  // 5. Fallback
  return {
    available: false,
    binary: null,
    binaryPath: null,
    message: "FDX native binary is unavailable; native TypeScript fallbacks active.",
    source: "none",
    target,
    targetSupported: target !== null,
    packagePresent: false,
    binaryPresent: false,
    binaryIntegrity: "fail",
    binaryVersion: null,
    versionCompatible: false,
    checksumStatus: "missing",
    executionStatus: "fail",
    fallbackAvailable: true,
    diagnostics,
    repairCommand,
  }
}

let fdxCacheKey: string | null = null
let fdxCacheValue: FdxResolutionResult | null = null
let fdxCacheBinarySha256: string | null = null

/**
 * Canonical, collision-free serialization of the resolution-cache identity.
 *
 * The identity is an ordered list of [field, value] tuples whose values may
 * contain arbitrary characters (including the "|" delimiter used by the old
 * string-joined key). A tuple list serialized with JSON.stringify is
 * unambiguous: two distinct inputs can never produce the same key.
 *
 * Beyond the environment inputs that change source eligibility, the identity
 * includes the resolved target cache directory. getFdxCacheDir() derives that
 * path from XDG_CACHE_HOME / LOCALAPPDATA / the home directory, so a switch of
 * any of those inputs (or a home-directory change) must invalidate the cache —
 * a long-running process must never serve a binary resolution computed for a
 * different cache root (P1-1).
 */
export function buildResolutionCacheKey(): string {
  const target = detectFdxTarget()
  const identity: Array<[string, string]> = [
    ["env", process.env.FDX_BINARY_PATH ?? ""],
    ["path", process.env.PATH ?? ""],
    ["profile", process.env.FLOWDECK_PROFILE ?? ""],
    ["nodeEnv", process.env.NODE_ENV ?? ""],
    ["localDev", process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE ?? ""],
    ["project", activeProjectDir],
    ["cwd", process.cwd()],
    ["version", getFlowdeckPackageVersion()],
    ["cacheRoot", target ? getFdxCacheDir(target) : ""],
  ]
  return JSON.stringify(identity)
}

/**
 * SHA-256 of a file, or null when the file cannot be read. Used to verify
 * that a cached binary is byte-for-byte identical to the one that passed the
 * trust contract immediately before execution (P1-2).
 */
export function sha256FileContents(binPath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(binPath)).digest("hex")
  } catch {
    return null
  }
}

/**
 * Open a binary once, hash the bytes of that SAME open descriptor, and return
 * the digest plus the descriptor's file identity (dev/ino). This binds the
 * digest to one specific open generation: a pathname that later resolves to a
 * different inode is a different file, regardless of same-size/same-mtime
 * tricks (P1-2).
 */
export function openAndHash(binPath: string): { sha: string; dev: number; ino: number } | null {
  let fd: number | null = null
  try {
    fd = openSync(binPath, "r")
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const buf = readFileSync(fd)
    const sha = createHash("sha256").update(buf).digest("hex")
    return { sha, dev: st.dev, ino: st.ino }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Contract 1 (verified execution): the shared pipeline every FDX execution
 * source funnels through — the `--version` probe, normal `runFdx`, managed
 * packages, repair-cache binaries, FDX_BINARY_PATH, and system PATH.
 *
 * Required sequence: open candidate → read/hash THOSE opened bytes →
 * checksum/trust verification → private execution snapshot written from
 * exactly those bytes → (test hook) → OS execution of the snapshot →
 * cleanup/close. The original candidate pathname is NEVER executed after
 * validation begins: a replacement-before-probe or same-inode mutation of the
 * path is invisible to the executed generation.
 *
 * The snapshot is a randomized, read-only file inside a mode-0700 private
 * directory — only this process knows the path, and the file cannot be
 * modified in place (POSIX 0500). The race is closed by byte binding to the
 * snapshot, never by stat/inode/post-exec digest checks.
 *
 * Returns { kind: "executed", out, sha256, byteLength } on success, or a
 * reject reason string when the generation cannot be proven.
 */
export function executeVerifiedSnapshot(
  bin: string,
  args: string[],
  trustedSha: string | null,
  opts: { timeout?: number; maxBuffer?: number } = {}
): { kind: "executed"; out: string; sha256: string; byteLength: number } | { kind: "rejected"; reason: string } {
  let fd: number | null = null
  let snapshotDir: string | null = null
  let snapshotPath: string | null = null
  try {
    fd = openSync(bin, "r")
    const st = fstatSync(fd)
    if (!st.isFile()) return { kind: "rejected", reason: "path is not a regular file" }
    const buf = readFileSync(fd)
    const sha = createHash("sha256").update(buf).digest("hex")
    if (trustedSha !== null && sha !== trustedSha) {
      return { kind: "rejected", reason: `binary digest ${sha} does not match trusted ${trustedSha}` }
    }
    // Private execution snapshot: randomized directory name (unpredictable,
    // process-scoped), mode 0700 so only this user can traverse it, file mode
    // 0500 (read+exec, not writable in place). Preserve the source extension
    // on Windows so .cmd/.bat/.exe execute correctly from the snapshot path.
    snapshotDir = join(tmpdir(), `flowdeck-fdx-snapshot-${process.pid}-${randomBytes(8).toString("hex")}`)
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
    const snapshotExt = process.platform === "win32" ? (extname(bin) || ".exe") : ""
    snapshotPath = join(snapshotDir, `fdx-snapshot${snapshotExt}`)
    writeFileSync(snapshotPath, buf, { mode: 0o500 })
    if (process.platform !== "win32") {
      try { chmodSync(snapshotPath, 0o500) } catch {}
    }
    // Test-only seam at the real boundary: validated snapshot created -> hook
    // -> OS execution call. Production callers never set this hook.
    if (fdxPreExecTestHookValue) fdxPreExecTestHookValue(snapshotPath, bin)
    const out = execFileSync(snapshotPath, args, {
      encoding: "utf-8",
      timeout: opts.timeout ?? FDX_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? FDX_MAX_BUFFER,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { kind: "executed", out, sha256: sha, byteLength: buf.length }
  } catch (err: any) {
    if (err?.code === "ENOBUFS") {
      return {
        kind: "rejected",
        reason: `fdx output exceeded ${FDX_MAX_BUFFER / 1024 / 1024}MB. ` +
          `Narrow the query: lower --max-matches, use a more specific pattern, ` +
          `or scope --path to a smaller file/directory.`,
      }
    }
    return { kind: "rejected", reason: err?.message ?? String(err) }
  } finally {
    if (snapshotPath !== null) {
      try { unlinkSync(snapshotPath) } catch {}
    }
    if (snapshotDir !== null) {
      try { rmSync(snapshotDir, { recursive: true, force: true }) } catch {}
    }
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

export function resolveFdxBinaryPath(forceRefresh = false): string | null {
  const status = getFdxAvailabilityStatus(forceRefresh)
  return status.binaryPath
}

export function checkFdxAvailability(forceRefresh = false): boolean {
  return getFdxAvailabilityStatus(forceRefresh).available
}

export function getFdxAvailabilityStatus(forceRefresh = false): FdxResolutionResult {
  const currentKey = buildResolutionCacheKey()
  if (!forceRefresh && fdxCacheKey === currentKey && fdxCacheValue !== null) {
    // P1-2: the cached binary must be re-verified before every native
    // execution. The stat fingerprint (dev/ino/size/mtime) can be bypassed by
    // rewriting the same inode with equal-length content and a restored mtime,
    // so the trusted SHA-256 is recomputed now and compared against the digest
    // captured when the binary passed the full trust contract. Any mismatch —
    // including a mutation between this check and execFileSync — fails closed
    // by dropping the cache and re-resolving.
    if (fdxCacheValue.binaryPath) {
      const currentSha = sha256FileContents(fdxCacheValue.binaryPath)
      if (fdxCacheBinarySha256 !== null && currentSha !== null && currentSha === fdxCacheBinarySha256) {
        return fdxCacheValue
      }
      // Digest changed, vanished, or was never captured: drop the cache and
      // re-resolve from scratch.
      fdxCacheKey = null
      fdxCacheValue = null
      fdxCacheBinarySha256 = null
      return getFdxAvailabilityStatus(true)
    }
    return fdxCacheValue
  }

  const res = resolveFdxBinaryPathDetailed()
  fdxCacheKey = currentKey
  fdxCacheValue = res
  // P1-1: never re-read the path to bless a fresh digest after validation.
  // The trusted digest is the one carried out of validation — the exact bytes
  // that passed the checksum contract. A post-validation re-read could observe
  // a different generation swapped in after the probe and would wrongly bless
  // it as trusted.
  fdxCacheBinarySha256 = res.validatedSha256 ?? null
  return res
}

export function shouldDisableFallback(): boolean {
  return process.env.FDX_DISABLE_FALLBACK === "1" || process.env.FDX_DISABLE_FALLBACK === "true"
}

function fdxBin(): string {
  const status = getFdxAvailabilityStatus()
  if (status.available && status.binaryPath) return status.binaryPath
  if (shouldDisableFallback()) {
    throw new Error(`[FDX Fallback Disabled] Native binary unavailable. FDX_BINARY_PATH="${process.env.FDX_BINARY_PATH || ""}"`)
  }
  throw new Error("fdx native binary unavailable and fallback disabled or not found — run 'flowdeck fdx repair'")
}

const FDX_TIMEOUT_MS = 30_000
const FDX_MAX_BUFFER = 50 * 1024 * 1024

/**
 * Test-only hook: when set, invoked inside executeVerifiedSnapshot at the real
 * boundary — validated snapshot created -> hook -> OS execution call — for
 * both the `--version` probe and command executions. Receives the private
 * snapshot path (first argument) and the original candidate path (second).
 * Lets a deterministic acceptance test replace/mutate the source at the exact
 * snapshot-to-exec boundary and assert the executed bytes are unchanged.
 * Production callers never set this hook.
 */
let fdxPreExecTestHookValue: ((snapshotPath: string, sourceBin: string) => void) | null = null
export function setFdxPreExecTestHook(hook: ((snapshotPath: string, sourceBin: string) => void) | null): void {
  fdxPreExecTestHookValue = hook
}

export function runFdx(args: string[]): string {
  const bin = fdxBin()
  validateExecutable(bin)
  validateArgs(args)
  // Contract 1: bind execution to the same immutable generation that passed
  // the trust contract. The resolution cache carries the trusted digest; the
  // verified-execution snapshot pipeline opens the candidate once, hashes the
  // bytes of that open generation, verifies them against the trusted digest,
  // writes a private execution snapshot from exactly those bytes, and executes
  // the snapshot — never the original pathname — failing closed on any
  // mismatch or missing digest.
  const trustedSha = fdxCacheBinarySha256
  if (trustedSha === null) {
    throw new Error(`[FDX Integrity] No trusted digest recorded for ${bin}; refusing to execute unverified binary`)
  }
  const result = executeVerifiedSnapshot(bin, args, trustedSha)
  if (result.kind === "executed") return result.out
  // Re-resolve once: the fresh resolution re-runs the full trust contract and
  // may observe a legitimate replacement (e.g. a repair installed a new binary).
  fdxCacheKey = null
  fdxCacheValue = null
  fdxCacheBinarySha256 = null
  const reResolved = getFdxAvailabilityStatus(true)
  if (reResolved.available && reResolved.binaryPath && reResolved.binaryPath !== bin) {
    return runFdx(args)
  }
  throw new Error(`[FDX Integrity] ${result.reason} (${bin})`)
}

// ─── Native TS Fallbacks ──────────────────────────────────────────────────

export function nativeReadFallback(file: string, limit?: number, offset?: number): string {
  try {
    if (!existsSync(file)) return `[FDX Fallback] Error: File not found "${file}"`
    const content = readFileSync(file, "utf-8")
    const lines = content.split("\n")
    const start = offset && offset > 0 ? offset - 1 : 0
    const end = limit && limit > 0 ? start + limit : lines.length
    const sliced = lines.slice(start, end).join("\n")
    return `[FDX Native Fallback: ${file}]\n${sliced}`
  } catch (err: any) {
    return `[FDX Fallback] Read error: ${err.message}`
  }
}

/**
 * Load .gitignore patterns and build a check function.
 * Simple implementation — reads the root .gitignore and caches patterns.
 */
function loadGitignorePatterns(root: string): (path: string) => boolean {
  const gitignorePath = join(root, ".gitignore")
  if (!existsSync(gitignorePath)) return () => false
  try {
    const content = readFileSync(gitignorePath, "utf-8")
    const patterns: string[] = []
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue
      patterns.push(trimmed)
    }
    return (filePath: string) => {
      const rel = filePath.replace(root, "").replace(/^[/\\]/, "")
      for (const pattern of patterns) {
        const p = pattern.replace(/\/$/, "")
        if (rel === p || rel.startsWith(p + "/") || rel.includes("/" + p)) return true
      }
      return false
    }
  } catch {
    return () => false
  }
}

/** Directories always excluded from search fallbacks. */
const ALWAYS_EXCLUDED = ["node_modules", ".git", "dist", "target", ".next", ".cache"]

export function nativeSearchFallback(query: string, searchPath: string = "."): string {
  try {
    const root = resolve(searchPath)
    const isIgnored = loadGitignorePatterns(root)
    const results: string[] = []

    const lowerQuery = query.toLowerCase()
    const queryRe = new RegExp(escapeRegex(query), "i")

    const walk = (dir: string) => {
      for (const item of readdirSync(dir)) {
        if (ALWAYS_EXCLUDED.includes(item)) continue
        const full = join(dir, item)
        if (isIgnored(full)) continue
        try {
          const st = statSync(full)
          if (st.isDirectory()) {
            walk(full)
          } else if (st.isFile()) {
            const text = readFileSync(full, "utf-8")

            // Fast reject: If the file content doesn't match case-insensitively, skip it entirely
            if (!queryRe.test(text)) continue

            const lines = text.split("\n")
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx]
              if (line.toLowerCase().includes(lowerQuery)) {
                results.push(`${full}:${idx + 1}:${line.trim()}`)
              }
            }
          }
        } catch { /* ignore unreadable */ }
      }
    }
    walk(root)
    if (results.length === 0) return `[FDX Native Fallback] No matches found for "${query}"`
    return `[FDX Native Fallback: ${results.length} matches]\n${results.join("\n")}`
  } catch (err: any) {
    return `[FDX Fallback] Search error: ${err.message}`
  }
}

export function nativeGitFallback(args: string[]): string {
  const subcommand = args[0]
  try {
    validateGitPolicy(subcommand, args.slice(1))
    validateArgs(args)
    return execFileSync("git", args, { encoding: "utf-8", timeout: 15000, shell: false })
  } catch (err: any) {
    return `[FDX Git Fallback Output]\n${err.stdout || err.stderr || err.message}`
  }
}

export function nativeLsFallback(targetPath: string = "."): string {
  try {
    const p = resolve(targetPath)
    if (!existsSync(p)) return `[FDX Fallback] Path not found: ${targetPath}`
    const items = readdirSync(p)
    return `[FDX Native Fallback: ${targetPath}]\n` + items.join("\n")
  } catch (err: any) {
    return `[FDX Fallback] Ls error: ${err.message}`
  }
}

/**
 * Simple regex-based outline fallback for when the fdx binary is unavailable.
 * Scans for common function/class/interface/type declarations.
 */
export function nativeOutlineFallback(paths: string[]): string {
  const results: string[] = []
  for (const p of paths) {
    const resolved = resolve(p)
    if (!existsSync(resolved)) {
      results.push(`[FDX Fallback] Path not found: ${p}`)
      continue
    }
    const st = statSync(resolved)
    if (st.isDirectory()) {
      results.push(nativeOutlineDir(resolved))
    } else if (st.isFile()) {
      results.push(nativeOutlineFile(resolved))
    }
  }
  return results.join("\n\n")
}

function nativeOutlineDir(dir: string): string {
  const lines: string[] = [`[FDX Native Fallback] Outline of ${dir}`]
  const walk = (d: string, depth: number) => {
    if (depth > 4) return
    for (const item of readdirSync(d)) {
      if (ALWAYS_EXCLUDED.includes(item)) continue
      const full = join(d, item)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          lines.push(`${"  ".repeat(depth)}📁 ${item}/`)
          walk(full, depth + 1)
        } else if (st.isFile() && /\.(ts|tsx|js|jsx|rs|py|go|java)$/.test(item)) {
          const fileOut = nativeOutlineFile(full)
          if (fileOut) lines.push(fileOut)
        }
      } catch { /* ignore */ }
    }
  }
  walk(dir, 0)
  return lines.join("\n")
}

/** Regex patterns for common declarations. */
const DECL_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  { regex: /^export\s+(async\s+)?function\s+(\w+)/gm, kind: "function" },
  { regex: /^(async\s+)?function\s+(\w+)/gm, kind: "function" },
  { regex: /^export\s+(default\s+)?(class|interface|type|enum|abstract\s+class)\s+(\w+)/gm, kind: "$2" },
  { regex: /^(class|interface|type|enum|abstract\s+class)\s+(\w+)/gm, kind: "$1" },
  { regex: /^export\s+const\s+(\w+)\s*[:=]/gm, kind: "const" },
  { regex: /^const\s+(\w+)\s*[:=].*=>/gm, kind: "arrow_function" },
  { regex: /^(fn|pub\s+fn)\s+(\w+)/gm, kind: "function" },
  { regex: /^(struct|trait|enum|impl)\s+(\w+)/gm, kind: "type" },
  { regex: /^def\s+(\w+)/gm, kind: "function" },
  { regex: /^class\s+(\w+)/gm, kind: "class" },
  { regex: /^func\s+(\w+)/gm, kind: "function" },
]

function nativeOutlineFile(filePath: string): string {
  try {
    const source = readFileSync(filePath, "utf-8")
    const symbols: Array<{ kind: string; name: string; line: number }> = []
    for (const { regex, kind } of DECL_PATTERNS) {
      let m: RegExpExecArray | null
      const re = new RegExp(regex.source, "gm")
      while ((m = re.exec(source)) !== null) {
        const lineNumber = source.slice(0, m.index).split("\n").length
        const name = m[m.length - 1] // last capture group is the name
        const kindStr = kind.startsWith("$") ? m[parseInt(kind[1])] || kind : kind
        symbols.push({ kind: kindStr, name, line: lineNumber })
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
    if (symbols.length === 0) return ""
    const header = `  ${filePath}`
    const body = symbols.map(s => `    ${s.line.toString().padStart(4)}  ${s.kind.padEnd(16)} ${s.name}`).join("\n")
    return `${header}\n${body}`
  } catch {
    return ""
  }
}

/**
 * Simple import-based impact fallback.
 * Scans TypeScript/JavaScript files for import/require statements matching the target files.
 * Uses a bounded concurrency queue for deterministic, fail-safe traversal.
 */
export async function nativeImpactFallback(
  files: string[],
  root: string = ".",
  options: { maxConcurrency?: number } = {}
): Promise<string> {
  const maxConcurrency = options.maxConcurrency ?? 16
  const targetNames = new Set(files.map(f => {
    const base = f.split(/[/\\]/).pop() ?? f
    return base.replace(/\.(ts|tsx|js|jsx)$/, "")
  }))

  const results: Array<{ file: string; matches: string[] }> = []
  const resolvedRoot = resolve(root)

  try {
    const rootStat = await fsPromises.stat(resolvedRoot)
    if (!rootStat.isDirectory()) {
      return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
    }
  } catch {
    return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
  }

  const queue: string[] = [resolvedRoot]
  let activeWorkers = 0

  await new Promise<void>((resolvePromise) => {
    const processQueue = async () => {
      while (queue.length > 0 && activeWorkers < maxConcurrency) {
        const dir = queue.shift()!
        activeWorkers++

        (async () => {
          try {
            const entries = await fsPromises.readdir(dir, { withFileTypes: true })
            entries.sort((a, b) => a.name.localeCompare(b.name))

            for (const item of entries) {
              if (ALWAYS_EXCLUDED.includes(item.name)) continue
              const full = join(dir, item.name)

              let isDir = item.isDirectory()
              let isFile = item.isFile()

              if (item.isSymbolicLink()) {
                try {
                  const targetStat = await fsPromises.stat(full)
                  isDir = targetStat.isDirectory()
                  isFile = targetStat.isFile()
                } catch {
                  continue
                }
              }

              if (isDir) {
                queue.push(full)
              } else if (isFile && /\.(ts|tsx|js|jsx)$/.test(item.name)) {
                try {
                  const text = await fsPromises.readFile(full, "utf-8")
                  const matches: string[] = []
                  for (const target of targetNames) {
                    const importRe = new RegExp(
                      `(?:from\\s+['"](?:[./]*/)?${escapeRegex(target)}|require\\(\\s*['"](?:[./]*/)?${escapeRegex(target)})`,
                      "i"
                    )
                    if (importRe.test(text)) {
                      matches.push(target)
                    }
                  }
                  if (matches.length > 0) {
                    matches.sort((a, b) => a.localeCompare(b))
                    results.push({ file: full, matches })
                  }
                } catch { /* per-file failure isolation */ }
              }
            }
          } catch {
            /* per-directory failure isolation */
          } finally {
            activeWorkers--
            if (queue.length === 0 && activeWorkers === 0) {
              resolvePromise()
            } else {
              processQueue()
            }
          }
        })()
      }

      if (queue.length === 0 && activeWorkers === 0) {
        resolvePromise()
      }
    }

    processQueue()
  })

  results.sort((a, b) => a.file.localeCompare(b.file))

  if (results.length === 0) {
    return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
  }

  const lines = [`[FDX Impact Native Fallback]`, `Target: ${files.join(", ")}`, ""]
  for (const r of results) {
    lines.push(`  ${r.file} → imports: ${r.matches.join(", ")}`)
  }
  return lines.join("\n")
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function nativeContextFallback(args: {
  action: "append" | "read" | "clear"
  topic: string
  agent?: string
  stage?: string
  summary?: string
}): Promise<string> {
  const path = topicContextPath(activeProjectDir, args.topic)
  if (args.action === "append") {
    const line = `### ${args.agent || "Agent"} (${args.stage || "Stage"})\n${args.summary || ""}\n`
    await appendWithLock(path, line)
    return `[FDX Context Fallback] Appended to ${path}`
  } else if (args.action === "read") {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No context logged for topic "${args.topic}"]`
  } else {
    await clearFileWithLock(path)
    return `[Context cleared for topic "${args.topic}"]`
  }
}

export async function nativeDecisionsFallback(args: {
  action: "record" | "read"
  topic: string
  decision?: string
  rationale?: string
  made_by?: string
}): Promise<string> {
  const path = topicDecisionsPath(activeProjectDir, args.topic)
  if (args.action === "record") {
    const line = `- **${args.decision || "Decision"}**: ${args.rationale || ""} (By: ${args.made_by || "Unknown"})\n`
    await appendWithLock(path, line)
    return `[FDX Decisions Fallback] Recorded to ${path}`
  } else {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No decisions recorded for topic "${args.topic}"]`
  }
}

