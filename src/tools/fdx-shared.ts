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
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants, promises as fsPromises } from "fs"
import { join, resolve, dirname } from "path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import {
  topicContextPath,
  topicDecisionsPath,
  appendWithLock,
  readOrMissing,
  clearFileWithLock,
} from "./planning-state-lib"
export { redactSecrets, containsSecrets } from "../lib/secret-redaction"
export { codebaseDir } from "./planning-state-lib"

// ─── Security: Executable and argument validation ──────────────────────────

export const DEFAULT_EXECUTABLE_ALLOWLIST = [
  "fdx",
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
}

export const MINIMUM_SUPPORTED_FDX_VERSION = "1.0.0"
export const MAXIMUM_SUPPORTED_FDX_MAJOR = 1
export const EXPECTED_FDX_PROTOCOL_VERSION = "1.0.0"
export const FLOWDECK_PACKAGE_VERSION = "1.0.4"

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
}

export function isSemverCompatible(version: string | null): { compatible: boolean; reason?: string } {
  if (!version) return { compatible: false, reason: "Missing version string" }
  const match = version.trim().match(/^v?([0-9]+)\.([0-9]+)\.([0-9]+)/)
  if (!match) return { compatible: false, reason: `Malformed semver version "${version}"` }

  const major = parseInt(match[1], 10)
  if (major < 1) {
    return { compatible: false, reason: `Version v${version} is below minimum supported v${MINIMUM_SUPPORTED_FDX_VERSION}` }
  }
  if (major > MAXIMUM_SUPPORTED_FDX_MAJOR) {
    return { compatible: false, reason: `Major version v${major} exceeds maximum supported v${MAXIMUM_SUPPORTED_FDX_MAJOR}` }
  }
  return { compatible: true }
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

export function getFdxCacheDir(target: FdxTarget, version = "1.0.4"): string {
  const targetName = `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "flowdeck", "fdx", version, targetName)
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || homedir(), "flowdeck", "cache", "fdx", version, targetName)
  }
  return join(homedir(), ".cache", "flowdeck", "fdx", version, targetName)
}

export function validateFdxBinaryPath(binPath: string, expectedDir?: string, requireManagedChecksum = false): {
  valid: boolean;
  version: string | null;
  versionCompatible: boolean;
  checksumStatus: "pass" | "fail" | "missing" | "unverified";
  integrity: FdxIntegrityResult;
  reason?: string;
} {
  if (!existsSync(binPath)) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus: "missing",
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
  let provenanceValid = false

  if (existsSync(checksumPath) || existsSync(provenancePath)) {
    try {
      let manifest: any = {}
      if (existsSync(provenancePath)) {
        manifest = JSON.parse(readFileSync(provenancePath, "utf-8"))
        provenanceValid = true
      }
      if (existsSync(checksumPath)) {
        const cManifest = JSON.parse(readFileSync(checksumPath, "utf-8"))
        manifest = { ...cManifest, ...manifest }
      }

      expectedSha = manifest.sha256 || manifest.checksum
      if (expectedSha) {
        const fileBuf = readFileSync(binPath)
        actualSha = createHash("sha256").update(fileBuf).digest("hex")
        if (actualSha === expectedSha) {
          checksumStatus = "pass"
          checksumMatch = true
        } else {
          checksumStatus = "fail"
          checksumMatch = false
          return {
            valid: false,
            version: null,
            versionCompatible: false,
            checksumStatus: "fail",
            integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, expectedSha256: expectedSha, actualSha256: actualSha, provenanceValid, reason: `Checksum mismatch: expected ${expectedSha}, got ${actualSha}` },
            reason: `Checksum mismatch: expected ${expectedSha}, got ${actualSha}`,
          }
        }
      } else if (requireManagedChecksum) {
        return {
          valid: false,
          version: null,
          versionCompatible: false,
          checksumStatus: "missing",
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
        integrity: { status: "fail", checksumStatus: "fail", checksumMatch: false, provenanceValid: false, reason: "Corrupt checksum/provenance manifest" },
        reason: "Corrupt checksum/provenance manifest",
      }
    }
  } else if (requireManagedChecksum) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus: "missing",
      integrity: { status: "fail", checksumStatus: "missing", checksumMatch: false, provenanceValid: false, reason: "Managed source missing mandatory checksum.json" },
      reason: "Managed source missing mandatory checksum.json",
    }
  }

  let version: string | null = null
  try {
    const out = execFileSync(binPath, ["--version"], { encoding: "utf-8", timeout: 3000, shell: process.platform === "win32" })
    const match = out.match(/fdx\s+v?([0-9]+\.[0-9]+\.[0-9]+)/i) || out.match(/v?([0-9]+\.[0-9]+\.[0-9]+)/)
    if (match && match[1]) {
      version = match[1]
    }
  } catch (err: any) {
    return {
      valid: false,
      version: null,
      versionCompatible: false,
      checksumStatus,
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
      integrity: { status: "fail", checksumStatus, checksumMatch, provenanceValid, reason: verCheck.reason },
      reason: verCheck.reason,
    }
  }

  return {
    valid: true,
    version,
    versionCompatible: true,
    checksumStatus,
    integrity: {
      status: (checksumStatus === "pass" || (!requireManagedChecksum && checksumStatus === "unverified")) ? "pass" : "fail",
      checksumStatus,
      checksumMatch,
      expectedSha256: expectedSha,
      actualSha256: actualSha,
      provenanceValid,
    },
  }
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

  // 2. Compatible FlowDeck platform package
  if (target) {
    const execName = target.executableName
    const pkgName = target.packageName
    const searchDirs: string[] = [
      activeProjectDir,
      process.cwd(),
      resolve(dirname(new URL(import.meta.url).pathname), "..", ".."),
    ]

    for (const searchDir of searchDirs) {
      let pkgDir: string | null = null
      try {
        const req = createRequire(join(searchDir, "package.json"))
        const jsonPath = req.resolve(`${pkgName}/package.json`)
        pkgDir = dirname(jsonPath)
      } catch {
        const candidate = join(searchDir, "node_modules", pkgName)
        if (existsSync(candidate)) pkgDir = candidate
        const localDev = join(searchDir, "packages", pkgName.replace("@heidi-dang/", ""))
        if (existsSync(localDev)) pkgDir = localDev
      }

      if (pkgDir && existsSync(pkgDir)) {
        const binPath = join(pkgDir, execName)
        const val = validateFdxBinaryPath(binPath, pkgDir, true)
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
            executionStatus: "pass",
            fallbackAvailable: true,
            diagnostics: [`Resolved compatible platform package binary at "${binPath}"`],
            repairCommand,
          }
        }
        diagnostics.push(`Platform package "${pkgName}" found at "${pkgDir}" but binary validation failed: ${val.reason}`)
      }
    }
  } else {
    diagnostics.push(`Platform target not supported for prebuilt binary distribution: ${process.platform}/${process.arch}`)
  }

  // 3. FlowDeck repair cache
  if (target) {
    const cacheDir = getFdxCacheDir(target)
    const cacheBin = join(cacheDir, target.executableName)
    if (existsSync(cacheBin)) {
      const val = validateFdxBinaryPath(cacheBin, cacheDir, true)
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

export function resolveFdxBinaryPath(forceRefresh = false): string | null {
  const status = getFdxAvailabilityStatus(forceRefresh)
  return status.binaryPath
}

export function checkFdxAvailability(forceRefresh = false): boolean {
  return getFdxAvailabilityStatus(forceRefresh).available
}

export function getFdxAvailabilityStatus(forceRefresh = false): FdxResolutionResult {
  const currentKey = `${process.env.FDX_BINARY_PATH || ""}:${process.env.PATH || ""}`
  if (!forceRefresh && fdxCacheKey === currentKey && fdxCacheValue !== null) {
    return fdxCacheValue
  }

  const res = resolveFdxBinaryPathDetailed()
  fdxCacheKey = currentKey
  fdxCacheValue = res
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

export function runFdx(args: string[]): string {
  const bin = fdxBin()
  validateExecutable(bin)
  validateArgs(args)
  try {
    return execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: FDX_TIMEOUT_MS,
      maxBuffer: FDX_MAX_BUFFER,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err: any) {
    if (err?.code === "ENOBUFS") {
      throw new Error(
        `fdx output exceeded ${FDX_MAX_BUFFER / 1024 / 1024}MB. ` +
        `Narrow the query: lower --max-matches, use a more specific pattern, ` +
        `or scope --path to a smaller file/directory.`
      )
    }
    throw err
  }
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

