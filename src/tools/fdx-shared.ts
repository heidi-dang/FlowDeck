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
import { existsSync, readFileSync, readdirSync, statSync, promises as fsPromises } from "fs"
import { join, resolve } from "path"
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

let fdxCacheKey: string | null = null
let fdxCacheValue: { available: boolean; binary: string | null } | null = null

export function resolveFdxBinaryPath(): string | null {
  const envPath = process.env.FDX_BINARY_PATH
  if (envPath) {
    const resolved = resolve(envPath)
    if (existsSync(resolved)) {
      try {
        const st = statSync(resolved)
        if (st.isFile()) return resolved
      } catch {}
    }
    return null
  }
  try {
    execFileSync("fdx", ["--help"], { stdio: "ignore", shell: false })
    return "fdx"
  } catch {
    return null
  }
}

export function checkFdxAvailability(forceRefresh = false): boolean {
  return getFdxAvailabilityStatus(forceRefresh).available
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

  const resolved = resolveFdxBinaryPath()
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
  throw new Error("fdx not found in PATH — install it with `bun run build:fdx` or set FDX_BINARY_PATH")
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
            const lines = text.split("\n")
            lines.forEach((line, idx) => {
              if (line.toLowerCase().includes(query.toLowerCase())) {
                results.push(`${full}:${idx + 1}:${line.trim()}`)
              }
            })
          }
        } catch { /* ignore unreadable */ }
      }
    }
    walk(root)
    if (results.length === 0) return `[FDX Native Fallback] No matches found for "${query}"`
    return `[FDX Native Fallback: ${results.length} matches]\n` + results.slice(0, 100).join("\n")
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
 */
export async function nativeImpactFallback(files: string[], root: string = "."): Promise<string> {
  const targetNames = new Set(files.map(f => {
    const base = f.split(/[/\\]/).pop() ?? f
    return base.replace(/\.(ts|tsx|js|jsx)$/, "")
  }))

  const results: Array<{ file: string; matches: string[] }> = []

  const walk = async (dir: string) => {
    let items
    try {
      items = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const promises = items.map(async (item) => {
      if (ALWAYS_EXCLUDED.includes(item.name)) return
      const full = join(dir, item.name)

      if (item.isDirectory()) {
        await walk(full)
      } else if (item.isFile() && /\.(ts|tsx|js|jsx)$/.test(item.name)) {
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
            results.push({ file: full, matches })
          }
        } catch { /* ignore */ }
      }
    })

    await Promise.all(promises)
  }

  const resolvedRoot = resolve(root)
  try {
    const st = await fsPromises.stat(resolvedRoot)
    if (st.isDirectory()) {
      await walk(resolvedRoot)
    }
  } catch {
    // root doesn't exist or not readable
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

export async function nativeContextFallback(
  action: "append" | "read" | "clear",
  topic: string,
  agent?: string,
  stage?: string,
  summary?: string,
): Promise<string> {
  const path = topicContextPath(activeProjectDir, topic)
  if (action === "append") {
    const line = `### ${agent || "Agent"} (${stage || "Stage"})\n${summary || ""}\n`
    await appendWithLock(path, line)
    return `[FDX Context Fallback] Appended to ${path}`
  } else if (action === "read") {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No context logged for topic "${topic}"]`
  } else {
    await clearFileWithLock(path)
    return `[Context cleared for topic "${topic}"]`
  }
}

export async function nativeDecisionsFallback(
  action: "record" | "read",
  topic: string,
  decision?: string,
  rationale?: string,
  made_by?: string,
): Promise<string> {
  const path = topicDecisionsPath(activeProjectDir, topic)
  if (action === "record") {
    const line = `- **${decision || "Decision"}**: ${rationale || ""} (By: ${made_by || "Unknown"})\n`
    await appendWithLock(path, line)
    return `[FDX Decisions Fallback] Recorded to ${path}`
  } else {
    const res = readOrMissing(path)
    return res.exists ? res.content : `[No decisions recorded for topic "${topic}"]`
  }
}
