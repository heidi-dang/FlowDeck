/**
 * FDX Tools — TypeScript tool definitions for the 14 fdx-* slash tools.
 *
 * Each tool checks availability of the fdx native binary, falls back to
 * a TypeScript implementation when the binary is unavailable, and provides
 * token-optimized output for LLM consumption.
 *
 * Shared infrastructure (validation, binary discovery, fallbacks) lives in
 * fdx-shared.ts. This file contains only the tool definitions.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import {
  checkFdxAvailability,
  shouldDisableFallback,
  runFdx,
  validateExecutable,
  validateArgs,
  validateGitPolicy,
  nativeReadFallback,
  nativeSearchFallback,
  nativeGitFallback,
  nativeLsFallback,
  nativeContextFallback,
  nativeDecisionsFallback,
  nativeOutlineFallback,
  nativeImpactFallback,
  TEST_RUNNER_ALLOWLIST,
  LINTER_ALLOWLIST,
} from "./fdx-shared"

// Re-export shared items for backward compatibility
export {
  DEFAULT_EXECUTABLE_ALLOWLIST,
  validateExecutable,
  type ValidateArgsOptions,
  validateArgs,
  GIT_READONLY_SUBCOMMANDS,
  validateGitPolicy,
  setActiveProjectDir,
  resolveFdxBinaryPath,
  checkFdxAvailability,
  getFdxAvailabilityStatus,
  shouldDisableFallback,
} from "./fdx-shared"

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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return args.files.map(f => nativeReadFallback(f, args.limit_per_file)).join("\n\n")
    }
    const cmd: string[] = ["batch", ...args.files]
    if (args.mode) cmd.push("--mode", args.mode)
    if (args.limit_per_file !== undefined) cmd.push("--limit-per-file", String(args.limit_per_file))
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return await nativeImpactFallback(args.files, args.root)
    }
    const cmd: string[] = ["impact", ...args.files]
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.direction) cmd.push("--direction", args.direction)
    if (args.format) cmd.push("--format", args.format)
    if (args.root) cmd.push("--root", args.root)
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
      return await nativeImpactFallback(args.files, args.root)
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
    const searchPaths = args.paths && args.paths.length > 0 ? args.paths : ["."]
    if (!checkFdxAvailability()) {
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeOutlineFallback(searchPaths)
    }
    const cmd: string[] = ["outline", ...searchPaths]
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.kind) cmd.push("--kind", args.kind)
    if (args.min_lines !== undefined) cmd.push("--min-lines", String(args.min_lines))
    if (args.format) cmd.push("--format", args.format)
    if (args.no_cache) cmd.push("--no-cache")
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
      return nativeOutlineFallback(searchPaths)
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
    try {
      validateGitPolicy(args.subcommand, args.args ?? [])
    } catch (err: any) {
      if (shouldDisableFallback()) throw err
      return `[FDX Git Policy] ${err.message}`
    }
    if (!checkFdxAvailability()) {
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeGitFallback([args.subcommand, ...(args.args ?? [])])
    }
    const cmd: string[] = ["git", args.subcommand]
    if (args.args && args.args.length > 0) cmd.push(...args.args)
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeLsFallback(args.path ?? ".")
    }
    const cmd: string[] = ["ls"]
    if (args.path) cmd.push(args.path)
    if (args.all) cmd.push("--all")
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeLsFallback(args.path ?? ".")
    }
    const cmd: string[] = ["tree"]
    if (args.path) cmd.push(args.path)
    if (args.depth !== undefined) cmd.push("--depth", String(args.depth))
    if (args.dirs_only) cmd.push("--dirs-only")
    if (args.format) cmd.push("--format", args.format)
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      try {
        const safeRunner = validateExecutable(args.runner, TEST_RUNNER_ALLOWLIST)
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
      try {
        const safeRunner = validateExecutable(args.runner, TEST_RUNNER_ALLOWLIST)
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      try {
        const safeLinter = validateExecutable(args.linter, LINTER_ALLOWLIST)
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
    } catch (err) {
      if (shouldDisableFallback()) throw err
      try {
        const safeLinter = validateExecutable(args.linter, LINTER_ALLOWLIST)
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
    "Per-topic agent-output log: append, read, clear, or read_artifact. Backed by the Rust `fdx context` " +
    "subcommand for atomic appends under an advisory file lock. Reading or clearing a missing " +
    "file is safe — returns a placeholder. Use read_artifact to retrieve externalized large tool outputs.",
  args: {
    action: tool.schema.enum(["append", "read", "clear", "read_artifact"]),
    topic: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    stage: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    artifact_id: tool.schema.string().optional(),
  },
  async execute(args): Promise<string> {
    // read_artifact is handled natively regardless of fdx availability
    if (args.action === "read_artifact") {
      return nativeContextFallback(args as any)
    }
    if (!checkFdxAvailability()) {
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeContextFallback(args as any)
    }
    const topic = args.topic || "general"
    const cmd: string[] = ["context", "--topic", topic, "--action", args.action]
    if (args.action === "append") {
      if (args.agent) cmd.push("--agent", args.agent)
      if (args.stage) cmd.push("--stage", args.stage)
      if (args.summary) cmd.push("--summary", args.summary)
    }
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
      return nativeContextFallback(args as any)
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
      if (shouldDisableFallback()) throw new Error("[FDX Fallback Disabled]")
      return nativeDecisionsFallback(args)
    }
    const cmd: string[] = ["decisions", "--topic", args.topic, "--action", args.action]
    if (args.action === "record") {
      if (args.decision) cmd.push("--decision", args.decision)
      if (args.rationale) cmd.push("--rationale", args.rationale)
      if (args.made_by) cmd.push("--made-by", args.made_by)
    }
    try {
      return runFdx(cmd)
    } catch (err) {
      if (shouldDisableFallback()) throw err
      return nativeDecisionsFallback(args)
    }
  },
})
