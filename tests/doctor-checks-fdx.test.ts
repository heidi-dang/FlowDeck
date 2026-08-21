import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { runFdxChecks } from "../src/doctor/checks/fdx"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Doctor FDX Checks", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fdx-checks-test-"))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it("evaluates when fdx index cache exists", async () => {
    const flowdeckDir = join(tmpDir, ".flowdeck")
    mkdirSync(flowdeckDir, { recursive: true })
    writeFileSync(join(flowdeckDir, "fdx-index.json"), "{}")

    const checks = await runFdxChecks(tmpDir)
    const indexCheck = checks.find((c) => c.id === "fdx.index_cache")
    expect(indexCheck).toBeDefined()
    expect(indexCheck?.status).toBe("pass")
    expect(indexCheck?.detected).toContain(".flowdeck/fdx-index.json present")
  })

  it("detects TS fallback or binary status in empty directory", async () => {
    const checks = await runFdxChecks(tmpDir)
    const binCheck = checks.find((c) => c.id === "fdx.native_binary")
    expect(binCheck).toBeDefined()
    expect(["pass", "warning", "error"]).toContain(binCheck!.status)
  })

  it("handles directory with TS fallback present", async () => {
    const srcTools = join(tmpDir, "src", "tools")
    mkdirSync(srcTools, { recursive: true })
    writeFileSync(join(srcTools, "fdx-shared.ts"), "// fallback")

    const checks = await runFdxChecks(tmpDir)
    const binCheck = checks.find((c) => c.id === "fdx.native_binary")
    expect(binCheck).toBeDefined()
    expect(["pass", "warning"]).toContain(binCheck!.status)
  })
})
