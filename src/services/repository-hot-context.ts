/**
 * RepositoryHotContext — In-memory cache for stable repository facts.
 *
 * Caches project root, HEAD SHA, branch, detected languages, package manager,
 * build/test/typecheck commands, layout summary, FlowDeck config snapshot,
 * governance mode, and FDX status.
 *
 * Invalidation:
 *   - Git HEAD change (commit/checkout)
 *   - Config file modification (.flowdeck.json, opencode.json, flowdeck.jsonc)
 *   - Package manifest change (package.json, Cargo.toml)
 *
 * Reading these stable facts from the cache avoids repeated shell executions
 * and filesystem reads during active turns.
 */

import { existsSync, statSync, readFileSync } from "fs"
import { join } from "path"
import { execFileSync } from "child_process"

export interface RepositoryContext {
  projectRoot: string
  headSha: string | null
  branch: string | null
  languages: string[]
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown"
  testCommand: string | null
  buildCommand: string | null
  typecheckCommand: string | null
  layoutSummary: string | null
  governanceMode: "off" | "advisory" | "strict"
  fdxAvailable: boolean
  capturedAt: number
  /** mtime checksum of invalidation trigger files */
  _triggerChecksum: string
}

function safeExec(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 }).trim()
  } catch {
    return null
  }
}

function detectLanguages(root: string): string[] {
  const langs: string[] = []
  const checks: Array<[string, string]> = [
    ["tsconfig.json", "typescript"],
    ["package.json", "javascript"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["requirements.txt", "python"],
    ["pyproject.toml", "python"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["Gemfile", "ruby"],
  ]
  for (const [file, lang] of checks) {
    if (existsSync(join(root, file)) && !langs.includes(lang)) {
      langs.push(lang)
    }
  }
  return langs
}

function detectPackageManager(root: string): RepositoryContext["packageManager"] {
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun"
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(root, "yarn.lock"))) return "yarn"
  if (existsSync(join(root, "package-lock.json"))) return "npm"
  return "unknown"
}

function detectCommands(root: string): { test: string | null; build: string | null; typecheck: string | null } {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf-8")
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    return {
      test: scripts["test"] ? "npm test" : null,
      build: scripts["build"] ? "npm run build" : null,
      typecheck: scripts["typecheck"] ? "npm run typecheck" : (scripts["tsc"] ? "npm run tsc" : null),
    }
  } catch {
    return { test: null, build: null, typecheck: null }
  }
}

function detectGovernanceMode(root: string): RepositoryContext["governanceMode"] {
  const candidates = [
    join(root, ".opencode", "flowdeck.jsonc"),
    join(root, ".opencode", "flowdeck.json"),
    join(root, ".flowdeck.json"),
    join(root, "opencode.json"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, "utf-8").replace(/\/\/[^\n]*/g, "")
      const cfg = JSON.parse(raw) as { governance?: { mode?: string } }
      const mode = cfg.governance?.mode
      if (mode === "off" || mode === "advisory" || mode === "strict") return mode
    } catch {
      // ignore malformed config
    }
  }
  return "advisory"
}

function detectFdx(): boolean {
  try {
    execFileSync("fdx", ["--version"], { encoding: "utf-8", stdio: "pipe", timeout: 1000 })
    return true
  } catch {
    return false
  }
}

function invalidationChecksum(root: string): string {
  const triggers = [
    join(root, ".git", "HEAD"),
    join(root, "package.json"),
    join(root, "Cargo.toml"),
    join(root, ".opencode", "flowdeck.jsonc"),
    join(root, ".opencode", "flowdeck.json"),
    join(root, ".flowdeck.json"),
  ]
  return triggers
    .filter(f => existsSync(f))
    .map(f => { try { return String(statSync(f).mtimeMs) } catch { return "0" } })
    .join("|")
}

function buildContext(root: string): RepositoryContext {
  const headSha = safeExec("git", ["rev-parse", "HEAD"], root)
  const branch = safeExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)
  const { test, build, typecheck } = detectCommands(root)
  return {
    projectRoot: root,
    headSha,
    branch,
    languages: detectLanguages(root),
    packageManager: detectPackageManager(root),
    testCommand: test,
    buildCommand: build,
    typecheckCommand: typecheck,
    layoutSummary: null,
    governanceMode: detectGovernanceMode(root),
    fdxAvailable: detectFdx(),
    capturedAt: Date.now(),
    _triggerChecksum: invalidationChecksum(root),
  }
}

// In-memory cache keyed by absolute project root
const _cache = new Map<string, RepositoryContext>()

/**
 * Get the cached RepositoryContext for a project root.
 * If the cache is missing or stale (trigger checksum changed), rebuilds it.
 */
export function getRepositoryContext(root: string): RepositoryContext {
  const cached = _cache.get(root)
  if (cached) {
    const currentChecksum = invalidationChecksum(root)
    if (currentChecksum === cached._triggerChecksum) {
      return cached
    }
    // Stale — rebuild
  }
  const ctx = buildContext(root)
  _cache.set(root, ctx)
  return ctx
}

/** Force-invalidate the cache for a project root. */
export function invalidateRepositoryContext(root: string): void {
  _cache.delete(root)
}

/** For tests only. */
export function _resetRepositoryContextCache(): void {
  _cache.clear()
}

/**
 * Render a compact layout string for injection into provider context.
 * Omits null/unknown fields.
 */
export function renderHotContextSummary(ctx: RepositoryContext): string {
  const lines: string[] = [`root:${ctx.projectRoot}`]
  if (ctx.headSha) lines.push(`sha:${ctx.headSha.slice(0, 8)}`)
  if (ctx.branch && ctx.branch !== "HEAD") lines.push(`branch:${ctx.branch}`)
  if (ctx.languages.length > 0) lines.push(`lang:${ctx.languages.join(",")}`)
  if (ctx.packageManager !== "unknown") lines.push(`pm:${ctx.packageManager}`)
  if (ctx.testCommand) lines.push(`test:${ctx.testCommand}`)
  if (ctx.buildCommand) lines.push(`build:${ctx.buildCommand}`)
  if (ctx.typecheckCommand) lines.push(`typecheck:${ctx.typecheckCommand}`)
  lines.push(`gov:${ctx.governanceMode}`)
  lines.push(`fdx:${ctx.fdxAvailable}`)
  return `[RepoCtx] ${lines.join(" | ")}`
}
