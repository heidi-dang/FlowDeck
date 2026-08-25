/**
 * FDX Shared Infrastructure
 *
 * Shared functions for all fdx-* tools: executable validation, argument validation,
 * git read-only policy enforcement, binary discovery, native fallbacks, and the
 * fdx subprocess runner.
 *
 * Extracted from fdx.ts to keep per-tool files focused.
 */

import { execFileSync, execFile } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, promises as fsPromises } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "node:url"
import { resolveContainedPath, isPathContained, getCanonicalRoot } from "./path-jail"
import {
  topicContextPath,
  topicDecisionsPath,
  appendWithLock,
  readOrMissing,
  clearFileWithLock,
} from "./planning-state-lib"

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
  "remote", "config", "check-ref-format", "write-tree",
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
    const trimmed = arg.trim()
    if (
      trimmed === "-c" ||
      trimmed.startsWith("-c=") ||
      trimmed.startsWith("-c ") ||
      trimmed.startsWith("-c") ||
      trimmed === "--config" ||
      trimmed.startsWith("--config=") ||
      trimmed.startsWith("--config ") ||
      trimmed === "--config-env" ||
      trimmed.startsWith("--config-env=") ||
      trimmed.startsWith("--config-env ")
    ) {
      throw new Error(`[FDX Git Policy] Prohibited config override "${arg}" under read-only policy.`)
    }
    if (trimmed === "--exec-path" || trimmed.startsWith("--exec-path=") || trimmed.startsWith("--exec-path ")) {
      throw new Error(`[FDX Git Policy] Blocked exec-path override "${arg}" under read-only policy.`)
    }
    if (
      trimmed === "--output" ||
      trimmed.startsWith("--output=") ||
      trimmed === "--ext-diff" ||
      trimmed === "--textconv" ||
      trimmed === "--paginate" ||
      trimmed === "--no-pager" ||
      trimmed === "--pager"
    ) {
      throw new Error(`[FDX Git Policy] Mutating/prohibited diff/execution flag "${arg}" is prohibited under read-only policy.`)
    }
    for (const pat of ["core.pager", "sequence.editor", "core.editor", "alias", "diff.external", "interactive"]) {
      if (trimmed.includes(pat)) {
        throw new Error(`[FDX Git Policy] Dangerous config option "${arg}" is prohibited under read-only policy.`)
      }
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

  if (sub === "remote") {
    const mutatingRemoteSub = new Set(["add", "rm", "remove", "set-url", "set-head", "set-branches", "rename", "prune", "update"])
    for (const arg of args) {
      if (mutatingRemoteSub.has(arg.toLowerCase())) {
        throw new Error(`[FDX Git Policy] Mutating remote operation "${arg}" is prohibited under read-only policy.`)
      }
    }
  }

  if (sub === "config") {
    const mutatingConfigFlags = new Set(["--set", "--set-all", "--add", "--unset", "--unset-all", "--remove-section", "--rename-section"])
    for (const arg of args) {
      if (mutatingConfigFlags.has(arg.toLowerCase())) {
        throw new Error(`[FDX Git Policy] Mutating config flag "${arg}" is prohibited under read-only policy.`)
      }
    }
    const positionals = args.filter(a => !a.startsWith("-"))
    const hasGetter = args.some(a => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a.toLowerCase()))
    if (positionals.length >= 2 && !hasGetter) {
      throw new Error(`[FDX Git Policy] Mutating config assignment attempt "${positionals.join(" ")}" is prohibited under read-only policy.`)
    }
  }
}

// ─── Binary discovery and caching ──────────────────────────────────────────

let activeProjectDir = process.cwd()

export function setActiveProjectDir(dir: string): void {
  activeProjectDir = dir
}

let fdxCacheKey: string | null = null
let fdxCacheValue: { available: boolean; binary: string | null } | null = null

function probeFdxBinary(): string | null {
  const envPath = process.env.FDX_BINARY_PATH
  if (envPath) {
    const resolved = resolve(envPath)
    if (existsSync(resolved)) {
      try {
        const st = statSync(resolved)
        if (st.isFile() && isCompatibleFdx(resolved)) return resolved
      } catch {}
    }
    return null
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const platformName = `${process.platform}-${process.arch}`
  for (const candidate of [
    join(packageRoot, "native", "fdx", platformName, process.platform === "win32" ? "fdx.exe" : "fdx"),
    join(packageRoot, "native", platformName, process.platform === "win32" ? "fdx.exe" : "fdx"),
  ]) {
    if (!existsSync(candidate)) continue
    try {
      const st = statSync(candidate)
      if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0) && isCompatibleFdx(candidate)) return candidate
    } catch { /* continue probing */ }
  }
  try {
    execFileSync("fdx", ["--help"], { stdio: "ignore", shell: false, timeout: 2_000 })
    const output = execFileSync("fdx", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, maxBuffer: 1024 * 1024 }).trim()
    return /^fdx\s+0\.1\./.test(output) ? "fdx" : null
  } catch {
    return null
  }
}

function isCompatibleFdx(binary: string): boolean {
  try { return /^fdx\s+0\.1\./.test(execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, maxBuffer: 1024 * 1024 }).trim()) }
  catch { return false }
}

export function invalidateFdxCache(): void {
  fdxCacheKey = null
  fdxCacheValue = null
}

export function checkFdxAvailability(forceRefresh = false): boolean {
  return getFdxAvailabilityStatus(forceRefresh).available
}

export function resolveFdxBinaryPath(forceRefresh = false): string | null {
  return getFdxAvailabilityStatus(forceRefresh).binary
}

export function getFdxAvailabilityStatus(forceRefresh = false): {
  available: boolean; binary: string | null; message: string
} {
  const currentKey = `${process.env.FDX_BINARY_PATH || ""}:${process.env.PATH || ""}`
  if (!forceRefresh && fdxCacheKey === currentKey && fdxCacheValue !== null) {
    return {
      available: fdxCacheValue.available,
      binary: fdxCacheValue.binary,
      message: fdxCacheValue.available
        ? `FDX native binary is available at "${fdxCacheValue.binary}".`
        : "FDX native binary is unavailable; native TypeScript fallbacks active.",
    }
  }

  const resolved = probeFdxBinary()
  const available = resolved !== null
  fdxCacheKey = currentKey
  fdxCacheValue = { available, binary: resolved }

  return {
    available,
    binary: resolved,
    message: available
      ? `FDX native binary is available at "${resolved}".`
      : "FDX native binary is unavailable; native TypeScript fallbacks active.",
  }
}

export function shouldDisableFallback(): boolean {
  return process.env.FDX_DISABLE_FALLBACK === "1" || process.env.FDX_DISABLE_FALLBACK === "true"
}

function fdxBin(): string {
  const status = getFdxAvailabilityStatus()
  if (status.available && status.binary) return status.binary
  if (shouldDisableFallback()) {
    throw new Error(`[FDX Fallback Disabled] Native binary unavailable. FDX_BINARY_PATH="${process.env.FDX_BINARY_PATH || ""}"`)
  }
  throw new Error("fdx native binary unavailable; TypeScript fallback is active. Install a supported FlowDeck package artifact or set FDX_BINARY_PATH")
}

export const FDX_TIMEOUT_MS = 30_000
export const FDX_MAX_BUFFER = 50 * 1024 * 1024

/**
 * Hard upper bound (ms) for a single live FDX tool request across ALL layers
 * (native daemon -> resident index -> one-shot native -> TS fallback). Ensures
 * the total request duration never accumulates multiple independent 30s waits.
 * OpenCode cancellation (AbortSignal) can end it earlier.
 */
export const FDX_TOOL_BUDGET_MS = 20_000

export function remainingDeadlineMs(deadline: number): number {
  const rem = deadline - Date.now()
  if (rem <= 0) throw new Error("FDX_TOOL_DEADLINE")
  return rem
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof Error) {
    if (err.name === "AbortError") return true
    if (err.message.includes("ABORTED") || err.message.includes("aborted") || err.message.includes("DEADLINE")) return true
  }
  const msg = String((err as any)?.message || err)
  return msg.includes("ABORTED") || msg.includes("aborted") || msg.includes("DEADLINE")
}

export interface RunFdxAsyncOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxBuffer?: number
  /** Optional observation hook invoked after the child process is created. */
  onSpawn?: (pid: number | undefined) => void
}

/**
 * Synchronous FDX native execution. Kept only for the startup compatibility
 * probe, offline scripts, and test-only paths. LIVE OpenCode tool execution
 * must use runFdxAsync so a slow call never blocks the plugin event loop.
 */
export function runFdx(args: string[], cwd?: string): string {
  const bin = fdxBin()
  validateExecutable(bin)
  validateArgs(args)
  try {
    return execFileSync(bin, args, {
      cwd: cwd || activeProjectDir || process.cwd(),
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
    if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") {
      throw new Error(
        `fdx execution timed out after ${FDX_TIMEOUT_MS / 1000}s. ` +
        `Narrow the query or reduce the target scope.`
      )
    }
    const stderrText = typeof err?.stderr === "string" ? err.stderr.trim() : (err?.stderr ? String(err.stderr).trim() : "")
    if (stderrText && !err.message.includes(stderrText)) {
      err.message = `${err.message} (${stderrText})`
    }
    throw err
  }
}

/**
 * Asynchronous FDX native execution. Used by the live tool path so that a slow
 * or wedged native call never blocks the OpenCode plugin event loop (unlike the
 * synchronous runFdx below). Always settles: resolves with stdout, or rejects
 * with a descriptive error on timeout / abort / spawn failure / non-zero exit.
 *
 * A hard `deadline` is derived from timeoutMs and checked against the caller's
 * AbortSignal so OpenCode cancellation can end the call earlier. Output is
 * bounded by maxBuffer (ENOBUFS is surfaced as a clear error).
 */
export function runFdxAsync(args: string[], opts: RunFdxAsyncOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? FDX_TIMEOUT_MS
  const maxBuffer = opts.maxBuffer ?? FDX_MAX_BUFFER
  const signal = opts.signal
  const cwd = opts.cwd || activeProjectDir || process.cwd()

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    let proc: ReturnType<typeof execFile> | undefined

    const onAbort = (): void => {
      if (proc) {
        try { proc.kill("SIGKILL") } catch {}
      }
      finish(new Error("FDX_NATIVE_ABORTED"), null)
    }

    const finish = (err: Error | null, out: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      if (err) rejectPromise(err)
      else resolvePromise(out as string)
    }

    // Binary resolution / arg validation errors must REJECT, not throw
    // synchronously, so runFdxAsync always settles (never leaves a caller in a
    // thrown/unhandled state).
    let bin: string
    try {
      bin = fdxBin()
      validateExecutable(bin)
      validateArgs(args)
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
      return
    }

    if (signal) {
      if (signal.aborted) { finish(new Error("FDX_NATIVE_ABORTED"), null); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    proc = execFile(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
      killSignal: "SIGTERM",
      windowsHide: true,
    }, (err, stdout) => {
      if (settled) return
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOBUFS") {
          finish(new Error(`fdx output exceeded ${maxBuffer / 1024 / 1024}MB. Narrow the query or reduce target scope.`), null)
        } else if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          finish(new Error(`fdx execution timed out after ${timeoutMs / 1000}s. Narrow the query or reduce the target scope.`), null)
        } else {
          const stderrText = typeof (err as any)?.stderr === "string" ? (err as any).stderr.trim() : ""
          if (stderrText) err.message = `${err.message} (${stderrText})`
          finish(err, null)
        }
        return
      }
      finish(null, stdout)
    })

    timer = setTimeout(() => {
      if (!settled) {
        try { proc.kill("SIGKILL") } catch {}
      }
    }, timeoutMs)
  })
}

/**
 * Asynchronous execution of an arbitrary allowlisted executable (test runners,
 * linters). Used so live tool execution never blocks the plugin event loop.
 * Always settles; resolves with stdout, rejects on timeout/abort/failure.
 */
export function runExecutableAsync(
  exe: string,
  args: string[],
  opts: RunFdxAsyncOptions = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? FDX_TIMEOUT_MS
  const maxBuffer = opts.maxBuffer ?? FDX_MAX_BUFFER
  const signal = opts.signal
  const cwd = opts.cwd || activeProjectDir || process.cwd()

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    let proc: ReturnType<typeof execFile> | undefined

    const onAbort = (): void => {
      if (proc) {
        try { proc.kill("SIGKILL") } catch {}
      }
      finish(new Error("FDX_EXEC_ABORTED"), null)
    }
    const finish = (err: Error | null, out: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      if (err) rejectPromise(err)
      else resolvePromise(out as string)
    }

    try {
      validateExecutable(exe)
      validateArgs(args)
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
      return
    }

    if (signal) {
      if (signal.aborted) { finish(new Error("FDX_EXEC_ABORTED"), null); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    proc = execFile(exe, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
      killSignal: "SIGTERM",
      windowsHide: true,
    }, (err, stdout) => {
      if (settled) return
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOBUFS") {
          finish(new Error(`output exceeded ${maxBuffer / 1024 / 1024}MB.`), null)
        } else if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          finish(new Error(`execution timed out after ${timeoutMs / 1000}s.`), null)
        } else {
          const stderrText = typeof (err as any)?.stderr === "string" ? (err as any).stderr.trim() : ""
          if (stderrText) err.message = `${err.message} (${stderrText})`
          finish(err, null)
        }
        return
      }
      finish(null, stdout)
    })

    try { opts.onSpawn?.(proc.pid) } catch {}

    timer = setTimeout(() => {
      if (!settled) { try { proc.kill("SIGKILL") } catch {} }
    }, timeoutMs)
  })
}

// ─── Native TS Fallbacks ──────────────────────────────────────────────────

let _nativeReadFallbackListener: ((file: string, limit?: number, offset?: number, cwd?: string) => void) | null = null

export function setNativeReadFallbackListenerForTest(
  listener: ((file: string, limit?: number, offset?: number, cwd?: string) => void) | null
): void {
  _nativeReadFallbackListener = listener
}

export function nativeReadFallback(file: string, limit?: number, offset?: number, cwd?: string): string {
  const effectiveDir = cwd || activeProjectDir || process.cwd()
  let resolvedPath: string
  try {
    resolvedPath = resolveContainedPath(effectiveDir, file, { mustExist: true })
  } catch (err: any) {
    return `[FDX Fallback] Read error: ${err.message}`
  }
  if (_nativeReadFallbackListener) {
    _nativeReadFallbackListener(resolvedPath, limit, offset, cwd)
  }
  try {
    const content = readFileSync(resolvedPath, "utf-8")
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

export function nativeSearchFallback(
  query: string,
  searchPath: string = ".",
  cwd?: string,
  opts?: { signal?: AbortSignal; deadlineMs?: number; maxFiles?: number }
): string {
  if (opts?.signal?.aborted) throw new Error("FDX_SEARCH_ABORTED")
  const startTime = Date.now()
  const deadlineMs = opts?.deadlineMs ?? FDX_TOOL_BUDGET_MS
  const maxFiles = opts?.maxFiles ?? 20_000
  let filesScanned = 0

  const effectiveDir = cwd || activeProjectDir || process.cwd()
  let root: string
  try {
    root = resolveContainedPath(effectiveDir, searchPath, { mustExist: false })
  } catch (err: any) {
    return `[FDX Fallback] Search error: ${err.message}`
  }
  const canonicalEffectiveRoot = getCanonicalRoot(effectiveDir)

  try {
    if (!existsSync(root)) return `[FDX Native Fallback] No matches found for "${query}"`
    const isIgnored = loadGitignorePatterns(root)
    const results: string[] = []

    const lowerQuery = query.toLowerCase()
    const queryRe = new RegExp(escapeRegex(query), "i")

    const walk = (dir: string) => {
      if (opts?.signal?.aborted) throw new Error("FDX_SEARCH_ABORTED")
      if (Date.now() - startTime > deadlineMs) throw new Error("FDX_TOOL_DEADLINE")
      if (filesScanned >= maxFiles) return

      for (const item of readdirSync(dir)) {
        if (opts?.signal?.aborted) throw new Error("FDX_SEARCH_ABORTED")
        if (Date.now() - startTime > deadlineMs) throw new Error("FDX_TOOL_DEADLINE")
        if (ALWAYS_EXCLUDED.includes(item)) continue
        const full = join(dir, item)
        if (isIgnored(full)) continue
        try {
          const st = statSync(full)
          if (!isPathContained(canonicalEffectiveRoot, full)) continue

          if (st.isDirectory()) {
            walk(full)
          } else if (st.isFile()) {
            filesScanned++
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
        } catch (err) {
          if (isAbortError(err)) throw err
          /* ignore unreadable */
        }
      }
    }
    walk(root)
    if (results.length === 0) return `[FDX Native Fallback] No matches found for "${query}"`
    return `[FDX Native Fallback: ${results.length} matches]\n${results.join("\n")}`
  } catch (err: any) {
    if (isAbortError(err)) throw err
    return `[FDX Fallback] Search error: ${err.message}`
  }
}

export function nativeGitFallback(args: string[], cwd?: string): string {
  const subcommand = args[0]
  try {
    validateGitPolicy(subcommand, args.slice(1))
    validateArgs(args)
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: FDX_MAX_BUFFER,
      shell: false,
      cwd: cwd || activeProjectDir || process.cwd(),
    })
  } catch (err: any) {
    return `[FDX Git Fallback Output]\n${err.stdout || err.stderr || err.message}`
  }
}

export function nativeLsFallback(targetPath: string = ".", cwd?: string): string {
  try {
    const effectiveDir = cwd || activeProjectDir || process.cwd()
    const p = resolveContainedPath(effectiveDir, targetPath, { mustExist: true })
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
export function nativeOutlineFallback(
  paths: string[],
  cwd?: string,
  opts?: { signal?: AbortSignal; deadlineMs?: number; maxFiles?: number }
): string {
  if (opts?.signal?.aborted) throw new Error("FDX_OUTLINE_ABORTED")
  const startTime = Date.now()
  const deadlineMs = opts?.deadlineMs ?? FDX_TOOL_BUDGET_MS
  const maxFiles = opts?.maxFiles ?? 20_000
  let filesScanned = 0

  const effectiveDir = cwd || activeProjectDir || process.cwd()
  const canonicalEffectiveRoot = getCanonicalRoot(effectiveDir)
  const results: string[] = []
  for (const p of paths) {
    if (opts?.signal?.aborted) throw new Error("FDX_OUTLINE_ABORTED")
    if (Date.now() - startTime > deadlineMs) throw new Error("FDX_TOOL_DEADLINE")
    let resolved: string
    try {
      resolved = resolveContainedPath(effectiveDir, p, { mustExist: true })
    } catch {
      results.push(`[FDX Fallback] Path not found: ${p}`)
      continue
    }
    const st = statSync(resolved)
    if (st.isDirectory()) {
      results.push(nativeOutlineDir(resolved, startTime, deadlineMs, maxFiles, filesScanned, canonicalEffectiveRoot, opts?.signal))
    } else if (st.isFile()) {
      filesScanned++
      results.push(nativeOutlineFile(resolved))
    }
  }
  return results.join("\n\n")
}

function nativeOutlineDir(
  dir: string,
  startTime: number,
  deadlineMs: number,
  maxFiles: number,
  filesScanned: number,
  canonicalRoot: string,
  signal?: AbortSignal
): string {
  const lines: string[] = [`[FDX Native Fallback] Outline of ${dir}`]
  const walk = (d: string, depth: number) => {
    if (signal?.aborted) throw new Error("FDX_OUTLINE_ABORTED")
    if (Date.now() - startTime > deadlineMs) throw new Error("FDX_TOOL_DEADLINE")
    if (depth > 4 || filesScanned >= maxFiles) return
    for (const item of readdirSync(d)) {
      if (signal?.aborted) throw new Error("FDX_OUTLINE_ABORTED")
      if (Date.now() - startTime > deadlineMs) throw new Error("FDX_TOOL_DEADLINE")
      if (ALWAYS_EXCLUDED.includes(item)) continue
      const full = join(d, item)
      if (!isPathContained(canonicalRoot, full)) continue
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          lines.push(`${"  ".repeat(depth)}📁 ${item}/`)
          walk(full, depth + 1)
        } else if (st.isFile() && /\.(ts|tsx|js|jsx|rs|py|go|java)$/.test(item)) {
          filesScanned++
          const fileOut = nativeOutlineFile(full)
          if (fileOut) lines.push(fileOut)
        }
      } catch (err) {
        if (isAbortError(err)) throw err
        /* ignore */
      }
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
 * Import-based impact fallback with hard bounded traversal (Requirement G).
 * Guarantees:
 *  - AbortSignal cancels traversal promptly (the returned promise settles).
 *  - Absolute deadline caps total runtime; exceeding limits returns an explicit
 *    FDX_IMPACT_FALLBACK_LIMIT result instead of hanging.
 *  - Symlink cycle protection via a visited canonical-path set.
 *  - Workspace containment: directory symlinks resolving outside the root are
 *    never followed, so `repo/foo -> /home` cannot escape into the filesystem.
 *  - Per-file/byte/directory limits bound memory and scan work.
 */
export async function nativeImpactFallback(
  files: string[],
  root: string = ".",
  options: {
    maxConcurrency?: number
    cwd?: string
    signal?: AbortSignal
    deadlineMs?: number
    maxDirs?: number
    maxFiles?: number
    maxBytesScanned?: number
  } = {}
): Promise<string> {
  const maxConcurrency = options.maxConcurrency ?? 16
  const effectiveDir = options.cwd || activeProjectDir || process.cwd()
  const signal = options.signal
  const deadlineMs = options.deadlineMs ?? FDX_TOOL_BUDGET_MS
  const maxDirs = options.maxDirs ?? 50_000
  const maxFiles = options.maxFiles ?? 100_000
  const maxBytesScanned = options.maxBytesScanned ?? 200 * 1024 * 1024

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error("FDX_IMPACT_ABORTED")
  }
  throwIfAborted()

  const resolvedRoot = resolve(effectiveDir, root)
  let canonicalEffectiveRoot: string
  try {
    canonicalEffectiveRoot = getCanonicalRoot(resolvedRoot)
  } catch {
    return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
  }

  for (const f of files) {
    if (!isPathContained(canonicalEffectiveRoot, f)) {
      return `[FDX Impact Native Fallback]\nPath escapes repository jail: ${f}`
    }
  }

  const targetNames = new Set(files.map(f => {
    const base = f.split(/[/\\\\]/).pop() ?? f
    return base.replace(/\.(ts|tsx|js|jsx)$/, "")
  }))

  const results: Array<{ file: string; matches: string[] }> = []

  try {
    const rootStat = await fsPromises.stat(resolvedRoot)
    if (!rootStat.isDirectory()) {
      return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
    }
  } catch {
    throwIfAborted()
    return `[FDX Impact Native Fallback]\nNo dependents found for: ${files.join(", ")}`
  }

  const rootCanonical = await fsPromises.realpath(resolvedRoot)
  const isContainedInRoot = (target: string): boolean => {
    return isPathContained(rootCanonical, target)
  }
  const startTime = Date.now()
  const visitedDirs = new Set<string>()
  let dirsScanned = 0
  let filesScanned = 0
  let bytesScanned = 0
  let limitHit = false

  const queue: string[] = [rootCanonical]
  let activeWorkers = 0
  const signalListeners: Array<() => void> = []

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      for (const off of signalListeners) if (signal) signal.removeEventListener("abort", off)
      if (err) rejectPromise(err)
      else resolvePromise()
    }

    if (signal) {
      const onAbort = (): void => { finish(new Error("FDX_IMPACT_ABORTED")) }
      if (signal.aborted) { finish(new Error("FDX_IMPACT_ABORTED")); return }
      signal.addEventListener("abort", onAbort, { once: true })
      signalListeners.push(onAbort)
    }

    const processQueue = async (): Promise<void> => {
      try {
        while (queue.length > 0 && activeWorkers < maxConcurrency) {
          if (signal?.aborted) { finish(new Error("FDX_IMPACT_ABORTED")); return }
          if (Date.now() - startTime > deadlineMs) { limitHit = true; finish(null); return }
          if (dirsScanned >= maxDirs) { limitHit = true; finish(null); return }
          if (filesScanned >= maxFiles) { limitHit = true; finish(null); return }
          if (bytesScanned >= maxBytesScanned) { limitHit = true; finish(null); return }

          const dir = queue.shift()!
          activeWorkers++

          ;(async () => {
            try {
              throwIfAborted()
              let canonical: string
              try { canonical = await fsPromises.realpath(dir) } catch { return }
              if (!isContainedInRoot(canonical)) return
              if (visitedDirs.has(canonical)) return
              visitedDirs.add(canonical)
              dirsScanned++

              const entries = await fsPromises.readdir(dir, { withFileTypes: true })
              entries.sort((a, b) => a.name.localeCompare(b.name))

              for (const item of entries) {
                if (signal?.aborted) { finish(new Error("FDX_IMPACT_ABORTED")); return }
                if (ALWAYS_EXCLUDED.includes(item.name)) continue
                if (limitHit) return
                const full = join(dir, item.name)

                let isDir = item.isDirectory()
                let isFile = item.isFile()

                if (item.isSymbolicLink()) {
                  try {
                    const resolvedTarget = await fsPromises.realpath(full)
                    // Workspace containment: never follow a symlink that escapes the root.
                    if (!isContainedInRoot(resolvedTarget)) continue
                    const targetStat = await fsPromises.stat(full)
                    isDir = targetStat.isDirectory()
                    isFile = targetStat.isFile()
                    if (isDir) {
                      if (visitedDirs.has(resolvedTarget)) continue
                      visitedDirs.add(resolvedTarget)
                    }
                  } catch {
                    continue
                  }
                }

                if (isDir) {
                  queue.push(full)
                } else if (isFile && /\.(ts|tsx|js|jsx)$/.test(item.name)) {
                  if (filesScanned >= maxFiles) { limitHit = true; return }
                  try {
                    const text = await fsPromises.readFile(full, "utf-8")
                    filesScanned++
                    bytesScanned += text.length
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
              if (!settled) {
                if (queue.length === 0 && activeWorkers === 0) {
                  finish(null)
                } else {
                  void processQueue()
                }
              }
            }
          })()
        }

        if (queue.length === 0 && activeWorkers === 0 && !settled) {
          finish(null)
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    }

    void processQueue()
  }).catch((err: Error) => {
    throw err
  })

  results.sort((a, b) => a.file.localeCompare(b.file))

  if (limitHit) {
    return `[FDX Impact Native Fallback]\nFDX_IMPACT_FALLBACK_LIMIT reached (dirs=${dirsScanned}, files=${filesScanned}, bytes=${bytesScanned}) — partial results:\n` +
      (results.length === 0 ? "No dependents found before limit." : results.map(r => `  ${r.file} → imports: ${r.matches.join(", ")}`).join("\n"))
  }

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
  action: "append" | "read" | "clear" | "read_artifact"
  topic?: string
  agent?: string
  stage?: string
  summary?: string
  artifact_id?: string
  cwd?: string
}): Promise<string> {
  if (args.action === "read_artifact") { return "Artifact store removed"; }

  const topic = args.topic || "general"
  const dir = args.cwd || activeProjectDir || process.cwd()
  const path = topicContextPath(dir, topic)
  if (args.action === "append") {
    const line = `### ${args.agent || "Agent"} (${args.stage || "Stage"})\n${args.summary || ""}\n`
    await appendWithLock(path, line)
    return `[FDX Context Fallback] Appended to ${path}`
  } else if (args.action === "read") {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No context logged for topic "${topic}"]`
  } else {
    await clearFileWithLock(path)
    return `[Context cleared for topic "${topic}"]`
  }
}

export async function nativeDecisionsFallback(args: {
  action: "record" | "read"
  topic: string
  decision?: string
  rationale?: string
  made_by?: string
  cwd?: string
}): Promise<string> {
  const dir = args.cwd || activeProjectDir || process.cwd()
  const path = topicDecisionsPath(dir, args.topic)
  if (args.action === "record") {
    const line = `- **${args.decision || "Decision"}**: ${args.rationale || ""} (By: ${args.made_by || "Unknown"})\n`
    await appendWithLock(path, line)
    return `[FDX Decisions Fallback] Recorded to ${path}`
  } else {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No decisions recorded for topic "${args.topic}"]`
  }
}
