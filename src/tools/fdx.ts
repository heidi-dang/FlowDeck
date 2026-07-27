import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, resolve } from "path"
import {
  topicContextPath,
  topicDecisionsPath,
  appendWithLock,
  readOrMissing,
  clearFileWithLock,
} from "./planning-state-lib"

// ─── Security: Executable and argument validation ──────────────────────────

/**
 * Validate that an executable name is in the allowlist.
 * Prevents command injection via arbitrary executable names.
 */
function validateExecutable(name: string, allowlist: string[]): string {
  if (!allowlist.includes(name)) {
    throw new Error(`Executable "${name}" is not in the allowlist. Allowed: ${allowlist.join(", ")}`)
  }
  // Ensure the name contains no path separators or shell metacharacters
  if (/[\\/;|&`$(){}[\]<>#!~]/.test(name)) {
    throw new Error(`Executable name "${name}" contains invalid characters`)
  }
  return name
}

/**
 * Validate argument array for shell injection attempts.
 * Rejects args containing shell metacharacters.
 * Allows normal file paths and flags.
 */
function validateArgs(args: string[]): string[] {
  // Shell metacharacters that enable command injection
  const INJECTION_CHARS = /[;|&`$(){}[\]<>!#~]/  // includes ;, |, &, `, $, etc.

  for (const arg of args) {
    if (INJECTION_CHARS.test(arg)) {
      throw new Error(`Argument "${arg}" rejected: contains shell metacharacters`)
    }
  }
  return args
}

/** Active project directory used by native fallback functions. */
let activeProjectDir = process.cwd()

/**
 * Set the active project directory for native fallback operations.
 * Called during plugin initialization to ensure fallbacks use the correct
 * project root rather than process.cwd() or a hardcoded ".".
 */
export function setActiveProjectDir(dir: string): void {
  activeProjectDir = dir
}

let fdxAvailableCache: boolean | null = null

/**
 * Check whether the fdx binary is available in PATH.
 */
export function checkFdxAvailability(forceRefresh = false): boolean {
  if (!forceRefresh && fdxAvailableCache !== null) {
    return fdxAvailableCache
  }
  try {
    execFileSync("fdx", ["--help"], { stdio: "ignore" })
    fdxAvailableCache = true
  } catch {
    fdxAvailableCache = false
  }
  return fdxAvailableCache
}

export function getFdxAvailabilityStatus(): { available: boolean; binary: string | null; message: string } {
  const available = checkFdxAvailability()
  return {
    available,
    binary: available ? "fdx" : null,
    message: available
      ? "FDX native binary is available and active."
      : "FDX native binary is unavailable; native TypeScript fallbacks active.",
  }
}

/** Resolve fdx binary: check PATH only (installed via cargo install). */
function fdxBin(): string {
  if (checkFdxAvailability()) {
    return "fdx"
  }
  throw new Error("fdx not found in PATH — install it with `bun run build:fdx`")
}

const FDX_TIMEOUT_MS = 30_000
const FDX_MAX_BUFFER = 50 * 1024 * 1024 // 50MB

function runFdx(args: string[]): string {
  const bin = fdxBin() // resolve lazily per call
  try {
    return execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: FDX_TIMEOUT_MS,
      maxBuffer: FDX_MAX_BUFFER,
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

// ── Native TS Fallbacks ──────────────────────────────────────────────────────

function nativeReadFallback(file: string, limit?: number, offset?: number): string {
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

function nativeSearchFallback(query: string, searchPath: string = "."): string {
  try {
    const results: string[] = []
    function walk(dir: string) {
      if (dir.includes("node_modules") || dir.includes(".git") || dir.includes("dist")) return
      for (const item of readdirSync(dir)) {
        const full = join(dir, item)
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
        } catch {
          // ignore unreadable files
        }
      }
    }
    walk(resolve(searchPath))
    if (results.length === 0) return `[FDX Native Fallback] No matches found for "${query}"`
    return `[FDX Native Fallback: ${results.length} matches]\n` + results.slice(0, 100).join("\n")
  } catch (err: any) {
    return `[FDX Fallback] Search error: ${err.message}`
  }
}

/** Read-only git subcommands permitted in the native fallback. */
const GIT_READONLY_ALLOWLIST = new Set([
  "status", "log", "diff", "show", "blame", "ls-files",
  "ls-tree", "rev-parse", "rev-list", "branch", "tag",
  "describe", "shortlog", "stash",
])

function nativeGitFallback(args: string[]): string {
  const subcommand = args[0]
  if (!subcommand || !GIT_READONLY_ALLOWLIST.has(subcommand)) {
    return `[FDX Git Fallback] Subcommand "${subcommand ?? ""}" is not in the read-only allowlist. ` +
      `Allowed: ${[...GIT_READONLY_ALLOWLIST].join(", ")}`
  }
  try {
    return execFileSync("git", args, { encoding: "utf-8", timeout: 15000 })
  } catch (err: any) {
    return `[FDX Git Fallback Output]\n${err.stdout || err.stderr || err.message}`
  }
}

function nativeLsFallback(targetPath: string = "."): string {
  try {
    const p = resolve(targetPath)
    if (!existsSync(p)) return `[FDX Fallback] Path not found: ${targetPath}`
    const items = readdirSync(p)
    return `[FDX Native Fallback: ${targetPath}]\n` + items.join("\n")
  } catch (err: any) {
    return `[FDX Fallback] Ls error: ${err.message}`
  }
}

async function nativeContextFallback(action: "append" | "read" | "clear", topic: string, agent?: string, stage?: string, summary?: string): Promise<string> {
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

async function nativeDecisionsFallback(action: "record" | "read", topic: string, decision?: string, rationale?: string, made_by?: string): Promise<string> {
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

// ── fdx-read ─────────────────────────────────────────────────────────────────

export const fdxReadTool: ToolDefinition = tool({
  description:
    "Read a file with token-optimized output. Prefer over native read_file for code files — " +
    "supports prototype mode (structure only), deep mode (symbol + dependencies), and raw mode.",
  args: {
    file: tool.schema.string(),
    mode: tool.schema.enum(["auto", "raw", "prototype", "deep"]).optional(),
    symbol: tool.schema.string().optional(),
    limit: tool.schema.number().optional(),
    offset: tool.schema.number().optional(),
    with_deps: tool.schema.boolean().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    no_cache: tool.schema.boolean().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeReadFallback(args.file, args.limit, args.offset)
    }
    const cmd: string[] = ["read", args.file]
    if (args.mode) cmd.push("--mode", args.mode)
    if (args.symbol) cmd.push("--symbol", args.symbol)
    if (args.limit !== undefined) cmd.push("--limit", String(args.limit))
    if (args.offset !== undefined) cmd.push("--offset", String(args.offset))
    if (args.with_deps !== undefined) cmd.push("--with-deps", String(args.with_deps))
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    try {
      return runFdx(cmd)
    } catch {
      return nativeReadFallback(args.file, args.limit, args.offset)
    }
  },
})

// ── fdx-search ───────────────────────────────────────────────────────────────

export const fdxSearchTool: ToolDefinition = tool({
  description:
    "Fast identifier and symbol search. Prefer over native grep when searching for symbol " +
    "definitions or usages — returns structured matches grouped by file and symbol.",
  args: {
    query: tool.schema.string(),
    path: tool.schema.string().optional(),
    kind: tool.schema.string().optional(),
    max_matches: tool.schema.number().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    no_cache: tool.schema.boolean().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeSearchFallback(args.query, args.path)
    }
    const cmd: string[] = ["search", args.query]
    if (args.path) cmd.push("--path", args.path)
    if (args.kind) cmd.push("--kind", args.kind)
    if (args.max_matches !== undefined) cmd.push("--max-matches", String(args.max_matches))
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    try {
      return runFdx(cmd)
    } catch {
      return nativeSearchFallback(args.query, args.path)
    }
  },
})

// ── fdx-grep ─────────────────────────────────────────────────────────────────

export const fdxGrepTool: ToolDefinition = tool({
  description:
    "Pattern matching across codebase files with token-optimized context lines.",
  args: {
    pattern: tool.schema.string(),
    path: tool.schema.string().optional(),
    context: tool.schema.number().optional(),
    max_matches: tool.schema.number().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    no_cache: tool.schema.boolean().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeSearchFallback(args.pattern, args.path)
    }
    const cmd: string[] = ["grep", args.pattern]
    if (args.path) cmd.push("--path", args.path)
    if (args.context !== undefined) cmd.push("--context", String(args.context))
    if (args.max_matches !== undefined) cmd.push("--max-matches", String(args.max_matches))
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    try {
      return runFdx(cmd)
    } catch {
      return nativeSearchFallback(args.pattern, args.path)
    }
  },
})

// ── fdx-batch ────────────────────────────────────────────────────────────────

export const fdxBatchTool: ToolDefinition = tool({
  description:
    "Read multiple files in a single tool call to save tokens and round-trips.",
  args: {
    files: tool.schema.array(tool.schema.string()),
    mode: tool.schema.enum(["auto", "raw", "prototype", "deep"]).optional(),
    limit_per_file: tool.schema.number().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return args.files.map(f => nativeReadFallback(f, args.limit_per_file)).join("\n\n")
    }
    const cmd: string[] = ["batch", ...args.files]
    if (args.mode) cmd.push("--mode", args.mode)
    if (args.limit_per_file !== undefined) cmd.push("--limit-per-file", String(args.limit_per_file))
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch {
      return args.files.map(f => nativeReadFallback(f, args.limit_per_file)).join("\n\n")
    }
  },
})

// ── fdx-impact ───────────────────────────────────────────────────────────────

export const fdxImpactTool: ToolDefinition = tool({
  description:
    "Analyze dependency impact of modifying specific files or symbols.",
  args: {
    files: tool.schema.array(tool.schema.string()),
    depth: tool.schema.number().optional(),
    direction: tool.schema.enum(["in", "out", "both"]).optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    root: tool.schema.string().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return `[FDX Impact Native Fallback]\nFiles target: ${args.files.join(", ")}`
    }
    const cmd: string[] = ["impact", ...args.files]
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.direction) cmd.push("--direction", args.direction)
    if (args.format) cmd.push("--format", args.format)
    if (args.root) cmd.push("--root", args.root)
    try {
      return runFdx(cmd)
    } catch {
      return `[FDX Impact Native Fallback]\nFiles target: ${args.files.join(", ")}`
    }
  },
})

// ── fdx-outline ──────────────────────────────────────────────────────────────

export const fdxOutlineTool: ToolDefinition = tool({
  description:
    "Project-wide symbol outline. Prefer over glob + read_file when orienting in an " +
    "unfamiliar codebase — shows all functions, classes, structs, and their hierarchy.",
  args: {
    paths: tool.schema.array(tool.schema.string()).optional(),
    depth: tool.schema.number().optional(),
    kind: tool.schema.string().optional(),
    min_lines: tool.schema.number().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    no_cache: tool.schema.boolean().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      const p = args.paths && args.paths.length > 0 ? args.paths[0] : "."
      return nativeSearchFallback("function", p)
    }
    const cmd: string[] = ["outline"]
    const paths = args.paths && args.paths.length > 0 ? args.paths : ["."]
    cmd.push(...paths)
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.kind) cmd.push("--kind", args.kind)
    if (args.min_lines !== undefined) cmd.push("--min-lines", String(args.min_lines))
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    try {
      return runFdx(cmd)
    } catch {
      const p = args.paths && args.paths.length > 0 ? args.paths[0] : "."
      return nativeSearchFallback("function", p)
    }
  },
})

// ── fdx-diff ─────────────────────────────────────────────────────────────────

export const fdxDiffTool: ToolDefinition = tool({
  description:
    "Symbol-aware git diff. Prefer over native git diff when reviewing changes — " +
    "shows which symbols changed and their context, not just line deltas.",
  args: {
    commit: tool.schema.string().optional(),
    paths: tool.schema.array(tool.schema.string()).optional(),
    staged: tool.schema.boolean().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
    no_cache: tool.schema.boolean().optional(),
    root: tool.schema.string().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      const gArgs = ["diff"]
      if (args.staged) gArgs.push("--staged")
      if (args.commit) gArgs.push(args.commit)
      if (args.paths) gArgs.push(...args.paths)
      return nativeGitFallback(gArgs)
    }
    const cmd: string[] = ["diff"]
    if (args.commit) cmd.push(args.commit)
    if (args.staged) cmd.push("--staged")
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    if (args.root) cmd.push("--root", args.root)
    if (args.paths && args.paths.length > 0) cmd.push(...args.paths)
    try {
      return runFdx(cmd)
    } catch {
      const gArgs = ["diff"]
      if (args.staged) gArgs.push("--staged")
      if (args.commit) gArgs.push(args.commit)
      if (args.paths) gArgs.push(...args.paths)
      return nativeGitFallback(gArgs)
    }
  },
})

// ── fdx-git ──────────────────────────────────────────────────────────────────

export const fdxGitTool: ToolDefinition = tool({
  description:
    "Token-optimized git subcommands. Prefer over native git/bash for status, log, diff, " +
    "and branch operations — filters noise and caps output for token efficiency.",
  args: {
    subcommand: tool.schema.string(),
    args: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeGitFallback([args.subcommand, ...(args.args ?? [])])
    }
    const cmd: string[] = ["git", args.subcommand]
    if (args.args && args.args.length > 0) cmd.push(...args.args)
    try {
      return runFdx(cmd)
    } catch {
      return nativeGitFallback([args.subcommand, ...(args.args ?? [])])
    }
  },
})

// ── fdx-ls ───────────────────────────────────────────────────────────────────

export const fdxLsTool: ToolDefinition = tool({
  description:
    "Compact directory listing. Prefer over native ls/bash for directory exploration — " +
    "groups directories first, caps entries, and returns structured output.",
  args: {
    path: tool.schema.string().optional(),
    all: tool.schema.boolean().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeLsFallback(args.path ?? ".")
    }
    const cmd: string[] = ["ls"]
    if (args.path) cmd.push(args.path)
    if (args.all) cmd.push("--all")
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch {
      return nativeLsFallback(args.path ?? ".")
    }
  },
})

// ── fdx-tree ─────────────────────────────────────────────────────────────────

export const fdxTreeTool: ToolDefinition = tool({
  description:
    "Gitignore-aware directory tree. Prefer over native tree/bash for project structure " +
    "visualization — respects .gitignore, skips build artifacts, and caps node count.",
  args: {
    path: tool.schema.string().optional(),
    depth: tool.schema.number().optional(),
    dirs_only: tool.schema.boolean().optional(),
    format: tool.schema.enum(["text", "json"]).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeLsFallback(args.path ?? ".")
    }
    const cmd: string[] = ["tree"]
    if (args.path) cmd.push(args.path)
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.dirs_only) cmd.push("--dirs-only")
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch {
      return nativeLsFallback(args.path ?? ".")
    }
  },
})

// ── fdx-test ─────────────────────────────────────────────────────────────────

export const fdxTestTool: ToolDefinition = tool({
  description:
    "Failures-only test runner wrapper. Prefer over native test commands — compresses " +
    "output to show only failing tests, strips passing test noise for token efficiency.",
  args: {
    runner: tool.schema.enum(["cargo", "pytest", "jest", "vitest", "go", "rspec", "rails"]),
    args: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      try {
        const safeRunner = validateExecutable(args.runner, ["cargo", "pytest", "jest", "vitest", "go", "rspec", "rails"])
        const safeArgs = validateArgs(args.args ?? [])
        return execFileSync(safeRunner, safeArgs, { encoding: "utf-8", timeout: 30000 })
      } catch (err: any) {
        return `[FDX Test Fallback Output]\n${err.stdout || err.stderr || err.message}`
      }
    }
    const cmd: string[] = ["test", args.runner]
    if (args.args && args.args.length > 0) cmd.push(...args.args)
    try {
      return runFdx(cmd)
    } catch {
      try {
        const safeRunner = validateExecutable(args.runner, ["cargo", "pytest", "jest", "vitest", "go", "rspec", "rails"])
        const safeArgs = validateArgs(args.args ?? [])
        return execFileSync(safeRunner, safeArgs, { encoding: "utf-8", timeout: 30000 })
      } catch (err: any) {
        return `[FDX Test Fallback Output]\n${err.stdout || err.stderr || err.message}`
      }
    }
  },
})

// ── fdx-lint ─────────────────────────────────────────────────────────────────

export const fdxLintTool: ToolDefinition = tool({
  description:
    "Failures-only lint wrapper. Prefer over native lint commands — compresses output " +
    "to show only issues, groups findings by file, and caps total findings.",
  args: {
    linter: tool.schema.enum(["ruff", "clippy", "tsc", "eslint", "biome", "golangci", "rubocop"]),
    args: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      try {
        const safeLinter = validateExecutable(args.linter, ["ruff", "clippy", "tsc", "eslint", "biome", "golangci", "rubocop"])
        const safeArgs = validateArgs(args.args ?? [])
        return execFileSync(safeLinter, safeArgs, { encoding: "utf-8", timeout: 30000 })
      } catch (err: any) {
        return `[FDX Lint Fallback Output]\n${err.stdout || err.stderr || err.message}`
      }
    }
    const cmd: string[] = ["lint", args.linter]
    if (args.args && args.args.length > 0) cmd.push(...args.args)
    try {
      return runFdx(cmd)
    } catch {
      try {
        const safeLinter = validateExecutable(args.linter, ["ruff", "clippy", "tsc", "eslint", "biome", "golangci", "rubocop"])
        const safeArgs = validateArgs(args.args ?? [])
        return execFileSync(safeLinter, safeArgs, { encoding: "utf-8", timeout: 30000 })
      } catch (err: any) {
        return `[FDX Lint Fallback Output]\n${err.stdout || err.stderr || err.message}`
      }
    }
  },
})

// ── fdx-context ──────────────────────────────────────────────────────────────

export const fdxContextTool: ToolDefinition = tool({
  description:
    "Per-topic agent-output log: append, read, or clear. Backed by the Rust `fdx context` " +
    "subcommand for atomic appends under an advisory file lock. Reading or clearing a missing " +
    "file is safe — returns a placeholder.",
  args: {
    action: tool.schema.enum(["append", "read", "clear"]),
    topic: tool.schema.string(),
    agent: tool.schema.string().optional(),
    stage: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeContextFallback(args.action, args.topic, args.agent, args.stage, args.summary)
    }
    const cmd: string[] = ["context", "--topic", args.topic, "--action", args.action]
    if (args.action === "append") {
      if (args.agent) cmd.push("--agent", args.agent)
      if (args.stage) cmd.push("--stage", args.stage)
      if (args.summary) cmd.push("--summary", args.summary)
    }
    try {
      return runFdx(cmd)
    } catch {
      return nativeContextFallback(args.action, args.topic, args.agent, args.stage, args.summary)
    }
  },
})

// ── fdx-decisions ────────────────────────────────────────────────────────────

export const fdxDecisionsTool: ToolDefinition = tool({
  description:
    "Per-topic design-decision log: record or read. Backed by the Rust `fdx decisions` " +
    "subcommand. For runtime-captured lessons (mistakes, debugging insights), prefer " +
    "`capture-lesson` — this tool is for design decisions with rationale and ownership.",
  args: {
    action: tool.schema.enum(["record", "read"]),
    topic: tool.schema.string(),
    decision: tool.schema.string().optional(),
    rationale: tool.schema.string().optional(),
    made_by: tool.schema.string().optional(),
  },
  async execute(args): Promise<string> {
    if (!checkFdxAvailability()) {
      return nativeDecisionsFallback(args.action, args.topic, args.decision, args.rationale, args.made_by)
    }
    const cmd: string[] = ["decisions", "--topic", args.topic, "--action", args.action]
    if (args.action === "record") {
      if (args.decision) cmd.push("--decision", args.decision)
      if (args.rationale) cmd.push("--rationale", args.rationale)
      if (args.made_by) cmd.push("--made-by", args.made_by)
    }
    try {
      return runFdx(cmd)
    } catch {
      return nativeDecisionsFallback(args.action, args.topic, args.decision, args.rationale, args.made_by)
    }
  },
})
