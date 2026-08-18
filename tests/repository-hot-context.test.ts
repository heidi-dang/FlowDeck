import { describe, it, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  getRepositoryContext,
  invalidateRepositoryContext,
  renderHotContextSummary,
  _resetRepositoryContextCache,
} from "../src/services/repository-hot-context"

function makeTemp(): string {
  return mkdtempSync(join(tmpdir(), "repo-hot-test-"))
}

describe("RepositoryHotContext — Milestone E2", () => {
  let tempDir: string

  beforeEach(() => {
    _resetRepositoryContextCache()
    tempDir = makeTemp()
  })

  it("returns a RepositoryContext with the correct root", () => {
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.projectRoot).toBe(tempDir)
  })

  it("detects TypeScript language from tsconfig.json", () => {
    writeFileSync(join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}')
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.languages).toContain("typescript")
  })

  it("detects npm as package manager from package-lock.json", () => {
    writeFileSync(join(tempDir, "package.json"), '{"name":"test"}')
    writeFileSync(join(tempDir, "package-lock.json"), '{}')
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.packageManager).toBe("npm")
  })

  it("detects bun as package manager from bun.lock", () => {
    writeFileSync(join(tempDir, "bun.lock"), '')
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.packageManager).toBe("bun")
  })

  it("detects test/build/typecheck commands from package.json scripts", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      name: "test-pkg",
      scripts: {
        test: "bun test",
        build: "bun build src/index.ts",
        typecheck: "tsc --noEmit",
      }
    }))
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.testCommand).toContain("test")
    expect(ctx.buildCommand).toContain("build")
    expect(ctx.typecheckCommand).toContain("typecheck")
  })

  it("caches the result and returns same object on repeated calls", () => {
    const ctx1 = getRepositoryContext(tempDir)
    const ctx2 = getRepositoryContext(tempDir)
    expect(ctx1).toBe(ctx2)
  })

  it("invalidates cache when invalidateRepositoryContext is called", () => {
    const ctx1 = getRepositoryContext(tempDir)
    invalidateRepositoryContext(tempDir)
    const ctx2 = getRepositoryContext(tempDir)
    // Different objects after invalidation
    expect(ctx1).not.toBe(ctx2)
  })

  it("renderHotContextSummary produces a compact summary string", () => {
    const ctx = getRepositoryContext(tempDir)
    const summary = renderHotContextSummary(ctx)
    expect(summary).toContain("[RepoCtx]")
    expect(summary).toContain("root:")
    expect(summary).toContain("gov:")
    expect(summary.length).toBeLessThan(500)
  })

  it("detects governance mode from .flowdeck.json", () => {
    writeFileSync(join(tempDir, ".flowdeck.json"), JSON.stringify({
      governance: { mode: "strict" }
    }))
    _resetRepositoryContextCache()
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.governanceMode).toBe("strict")
  })

  it("defaults to advisory governance mode when no config exists", () => {
    const ctx = getRepositoryContext(tempDir)
    expect(ctx.governanceMode).toBe("advisory")
  })
})
