import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { RepoMaster, parseRepoMasterAdvice, repoMasterConsultationRequirement } from "../src/orchestration/repository/repo-master"
import type { RouterDecision } from "../src/services/heidi-fast-router"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function command(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" })
}

function fixture(name = "repo-master"): string {
  const root = join(tmpdir(), `flowdeck-${name}-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "tests"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, scripts: { test: "bun test", typecheck: "tsc --noEmit" } }))
  writeFileSync(join(root, "src", "auth-service.ts"), "export function authenticate(token: string) { return token.length > 0 }\n")
  writeFileSync(join(root, "src", "app.ts"), "import { authenticate } from './auth-service'\nexport const start = () => authenticate('ok')\n")
  writeFileSync(join(root, "tests", "auth-service.test.ts"), "import { authenticate } from '../src/auth-service'\n")
  command(root, ["init", "-q"])
  command(root, ["config", "user.email", "repo-master@example.test"])
  command(root, ["config", "user.name", "Repo Master Test"])
  command(root, ["add", "."])
  command(root, ["commit", "-qm", "initial"])
  return root
}

function decision(overrides: Partial<RouterDecision> = {}): RouterDecision {
  return {
    executionClass: "PARALLEL_SPECIALISTS",
    executionMode: "MULTI_SPECIALIST",
    reason: "Cross-component repository change",
    reasonCode: "MULTI_CROSS_DOMAIN",
    confidence: 0.9,
    forcedByExplicitSignal: false,
    specialists: ["BACKEND", "REVIEW"],
    suggestedAgents: ["backend-coder", "reviewer"],
    ...overrides,
  }
}

function request(runId = "run-1", goal = "Fix authentication dependency behavior across the backend and add regression tests") {
  return { runId, goal, executionMode: "MULTI_SPECIALIST" as const, decision: decision() }
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0
}

describe("Repo Master durable advisory repository intelligence", () => {
  it("builds a bounded current repository view from existing FDX metadata", () => {
    const root = fixture()
    const result = new RepoMaster(root).consult(request())
    expect(result.advice.repository.root).toBe(realpathSync(root))
    expect(result.advice.relevantFiles).toContain("src/auth-service.ts")
    expect(result.advice.dependencyEdges.some(edge => edge.from === "src/app.ts" && edge.to.includes("auth-service"))).toBe(true)
    expect(result.advice.likelyTests).toContain("tests/auth-service.test.ts")
    expect(result.advice.evidenceSources).toEqual(["fdx_workspace_index", "repository_hot_context", "repository_source_fingerprint"])
  })

  it("binds advice to a realpath repository identity and rejects cross-project reuse", () => {
    const a = fixture("a")
    const b = fixture("b")
    const advice = new RepoMaster(a).consult(request()).advice
    const other = new RepoMaster(b)
    expect(other.isAdviceFresh(advice)).toBe(false)
    expect(advice.repository.repositoryId).not.toBe(other.sourceState().repositoryId)
  })

  it("detects HEAD and meaningful dirty-tree changes as stale", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const advice = master.consult(request()).advice
    writeFileSync(join(root, "src", "auth-service.ts"), "export const authenticate = () => false\n")
    expect(master.isAdviceFresh(advice)).toBe(false)
    command(root, ["add", "src/auth-service.ts"])
    command(root, ["commit", "-qm", "change auth"])
    expect(master.isAdviceFresh(advice)).toBe(false)
    expect(master.diagnostics().fresh).toBe(false)
  })

  it("invalidates source state on package manifests and runtime configuration without relying on Git status alone", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const initial = master.sourceState()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "changed", scripts: { test: "bun test" } }))
    const packageChanged = master.sourceState()
    expect(packageChanged.packageFingerprint).not.toBe(initial.packageFingerprint)
    expect(packageChanged.fingerprint).not.toBe(initial.fingerprint)
    writeFileSync(join(root, ".flowdeck.json"), JSON.stringify({ routing: { mode: "advisory" } }))
    const configChanged = master.sourceState()
    expect(configChanged.configFingerprint).not.toBe(packageChanged.configFingerprint)
    expect(configChanged.fingerprint).not.toBe(packageChanged.fingerprint)
  })

  it("treats detached HEAD and explicit targeted invalidation as stale until bounded refresh", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const first = master.consult(request())
    command(root, ["checkout", "--detach", "-q"])
    expect(master.isAdviceFresh(first.advice)).toBe(false)
    const detached = master.consult(request())
    expect(detached.cacheHit).toBe(false)
    master.invalidate(["src/auth-service.ts"])
    expect(master.diagnostics().fresh).toBe(false)
    expect(master.consult(request()).cacheHit).toBe(false)
  })

  it("rejects oversized malformed persisted advice without reusing it", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const advice = master.consult(request()).advice
    const malformed = { ...advice, scope: Array.from({ length: 13 }, (_, index) => `src/${index}.ts`) }
    expect(parseRepoMasterAdvice(JSON.stringify(malformed))).toBeNull()
    const stateFile = join(root, ".flowdeck", "repo-master.json")
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    state.advice = [malformed]
    writeFileSync(stateFile, JSON.stringify(state))
    const restarted = new RepoMaster(root)
    expect(restarted.diagnostics().corruptStateRecovered).toBe(true)
    expect(restarted.consult(request()).cacheHit).toBe(false)
  })

  it("ignores only its own metadata while treating user-authored .flowdeck content as a meaningful change", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const advice = master.consult(request()).advice
    expect(master.isAdviceFresh(advice)).toBe(true)
    writeFileSync(join(root, ".flowdeck", "user-policy.json"), JSON.stringify({ owner: "user" }))
    expect(master.isAdviceFresh(advice)).toBe(false)
  })

  it("uses an identical same-run request cache only while repository state remains fresh", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const first = master.consult(request())
    const second = master.consult(request())
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.advice.requestId).toBe(first.advice.requestId)
    expect(master.diagnostics().cacheHits).toBe(1)
    writeFileSync(join(root, "README.md"), "meaningful untracked change\n")
    expect(master.consult(request()).cacheHit).toBe(false)
  })

  it("survives restart with valid shared metadata while retaining run-specific advice only in routing evidence", () => {
    const root = fixture()
    const first = new RepoMaster(root)
    const advice = first.consult(request()).advice
    const stateFile = join(root, ".flowdeck", "repo-master.json")
    const persisted = readFileSync(stateFile, "utf8")
    expect(persisted).not.toContain(advice.runId)
    expect(persisted).not.toContain(advice.requestId)
    expect(JSON.parse(persisted).advice).toBeUndefined()
    const restarted = new RepoMaster(root)
    expect(restarted.isAdviceFresh(advice)).toBe(true)
    expect(restarted.diagnostics().fresh).toBe(true)
    expect(restarted.consult(request()).cacheHit).toBe(false)
    writeFileSync(stateFile, "{ definitely not JSON")
    const corrupt = new RepoMaster(root)
    expect(corrupt.diagnostics().corruptStateRecovered).toBe(true)
    expect(corrupt.diagnostics().fresh).toBe(false)
    expect(corrupt.consult(request()).advice.relevantFiles.length).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(stateFile, "utf8")).version).toBe("1.0.0")
  })

  it("keeps run-specific advice isolated while allowing shared repository intelligence", () => {
    const root = fixture()
    const master = new RepoMaster(root)
    const a = master.consult(request("run-a"))
    const b = master.consult(request("run-b"))
    expect(a.advice.repository.fingerprint).toBe(b.advice.repository.fingerprint)
    expect(a.advice.requestId).not.toBe(b.advice.requestId)
    expect(a.advice.runId).toBe("run-a")
    expect(b.advice.runId).toBe("run-b")
  })

  it("keeps direct work cheap and requires advice for repository-significant multi-specialist work", () => {
    expect(repoMasterConsultationRequirement({ goal: "What version is configured?", executionMode: "DIRECT", decision: decision({ executionClass: "FAST_DIRECT", executionMode: "DIRECT" }) })).toBe("none")
    expect(repoMasterConsultationRequirement({ goal: "Migrate authentication dependencies across workspace packages", executionMode: "MULTI_SPECIALIST", decision: decision() })).toBe("required")
    expect(repoMasterConsultationRequirement({ goal: "Investigate a focused backend failure", executionMode: "SINGLE_SPECIALIST", decision: decision({ executionClass: "SPECIALIST", executionMode: "SINGLE_SPECIALIST" }) })).toBe("optional")
  })

  it("keeps warm advisory cache and bounded refresh latency within deterministic resource limits", () => {
    const root = fixture("performance")
    const master = new RepoMaster(root)
    master.consult(request("perf-warm"))
    const warmSamples = Array.from({ length: 15 }, () => {
      const startedAt = performance.now()
      const result = master.consult(request("perf-warm"))
      expect(result.cacheHit).toBe(true)
      return performance.now() - startedAt
    })
    expect(percentile(warmSamples, 0.95)).toBeLessThan(500)

    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(root, "src", `feature-${index}.ts`), `export const feature${index} = ${index}\n`)
    }
    const refreshStartedAt = performance.now()
    const refreshed = master.consult(request("perf-refresh", "Assess changed feature dependencies across the repository"))
    const refreshDuration = performance.now() - refreshStartedAt
    expect(refreshed.cacheHit).toBe(false)
    expect(refreshed.advice.relevantFiles.length).toBeLessThanOrEqual(24)
    expect(refreshed.advice.dependencyEdges.length).toBeLessThanOrEqual(48)
    expect(refreshDuration).toBeLessThan(2_000)

    for (let index = 0; index < 80; index += 1) master.consult(request(`perf-run-${index}`))
    const stateFile = join(root, ".flowdeck", "repo-master.json")
    expect(statSync(stateFile).size).toBeLessThan(2_048)
    expect(readFileSync(stateFile, "utf8")).not.toContain("perf-run-")
  }, 15_000)

  it("supports a minimal repository without duplicating source or requiring a package graph", () => {
    const root = join(tmpdir(), `flowdeck-empty-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    command(root, ["init", "-q"])
    command(root, ["config", "user.email", "repo-master@example.test"])
    command(root, ["config", "user.name", "Repo Master Test"])
    writeFileSync(join(root, "README.md"), "minimal repository\n")
    command(root, ["add", "."])
    command(root, ["commit", "-qm", "minimal"])
    const advice = new RepoMaster(root).consult(request("minimal", "Assess this repository"))
    expect(advice.advice.relevantPackages).toEqual([])
    expect(advice.advice.relevantFiles).toContain("README.md")
    expect(existsSync(join(root, ".flowdeck", "repo-master.json"))).toBe(true)
  })
})
