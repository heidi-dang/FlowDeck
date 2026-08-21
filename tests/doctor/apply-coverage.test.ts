import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test"
import { applyAutoFixes } from "../../src/doctor/apply/apply"
import type { CheckResult, DoctorOptions } from "../../src/doctor/types"
import * as childProcess from "child_process"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("doctor applyAutoFixes", () => {
  let execSpy: ReturnType<typeof vi.spyOn>
  const testHome = join(tmpdir(), "doctor-apply-test-" + Math.random().toString(36).slice(2))

  beforeEach(() => {
    if (existsSync(testHome)) rmSync(testHome, { recursive: true })
    mkdirSync(testHome, { recursive: true })
    execSpy = vi.spyOn(childProcess, "execFileSync")
  })

  afterEach(() => {
    execSpy.mockRestore()
    if (existsSync(testHome)) rmSync(testHome, { recursive: true })
  })

  it("handles dryRun mode", async () => {
    const checks: CheckResult[] = [
      { id: "plugin.bundle", title: "Bundle", category: "plugin", severity: "high", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
      { id: "config.opencode_user", title: "User", category: "configuration", severity: "medium", status: "pass", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
      { id: "other", title: "Other", category: "runtime", severity: "low", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: false },
    ]
    const opts: DoctorOptions = { dryRun: true, json: false, nonInteractive: true, profile: "default" }
    const results = await applyAutoFixes(checks, opts)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe("fix_plugin.bundle")
    expect(results[0].applied).toBe(false)
  })

  it("handles autoFixBuild success and failure", async () => {
    const checks: CheckResult[] = [
      { id: "plugin.bundle", title: "Bundle", category: "plugin", severity: "high", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
    ]
    const opts: DoctorOptions = { dryRun: false, json: false, nonInteractive: true, profile: "default" }

    execSpy.mockReturnValue(Buffer.from("ok"))
    const successRes = await applyAutoFixes(checks, opts)
    expect(successRes[0].applied).toBe(true)

    execSpy.mockImplementation(() => { throw new Error("build fail") })
    const failRes = await applyAutoFixes(checks, opts)
    expect(failRes[0].applied).toBe(false)
    expect(failRes[0].error).toContain("build fail")
  })

  it("handles autoFixInstall via CLI and fallback", async () => {
    const checks: CheckResult[] = [
      { id: "config.opencode_user", title: "User", category: "configuration", severity: "high", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
    ]
    const opts: DoctorOptions = { dryRun: false, json: false, nonInteractive: true, profile: "default" }

    execSpy.mockReturnValue(Buffer.from("ok"))
    const cliRes = await applyAutoFixes(checks, opts)
    expect(cliRes[0].applied).toBe(true)

    execSpy.mockImplementation((file: string) => {
      if (file === "flowdeck") throw new Error("flowdeck command not found")
      return Buffer.from("installed via bash")
    })
    const bashRes = await applyAutoFixes(checks, opts)
    expect(bashRes[0].applied).toBe(true)
    expect(bashRes[0].description).toContain("install.sh")

    execSpy.mockImplementation(() => { throw new Error("all fail") })
    const allFail = await applyAutoFixes(checks, opts)
    expect(allFail[0].applied).toBe(false)
  })

  it("handles autoFixRuntimeIdentity cleaning cache and package dirs", async () => {
    const origCache = process.env.XDG_CACHE_HOME
    const origData = process.env.XDG_DATA_HOME
    try {
      const cachePkgs = join(testHome, "cache", "opencode", "packages")
      mkdirSync(join(cachePkgs, "flowdeck-old"), { recursive: true })
      writeFileSync(join(cachePkgs, "flowdeck-old", "package.json"), JSON.stringify({ name: "@heidi-dang/flowdeck" }))
      mkdirSync(join(cachePkgs, "other-pkg"), { recursive: true })
      writeFileSync(join(cachePkgs, "other-pkg", "package.json"), JSON.stringify({ name: "other" }))

      process.env.XDG_CACHE_HOME = join(testHome, "cache")
      process.env.XDG_DATA_HOME = join(testHome, "data")

      const checks: CheckResult[] = [
        { id: "plugin.runtime_identity", title: "Runtime", category: "runtime", severity: "high", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
        { id: "unknown.check", title: "Unknown", category: "runtime", severity: "low", status: "error", detected: "", expected: "", recommendation: "", autoFixAvailable: true },
      ]
      const opts: DoctorOptions = { dryRun: false, json: false, nonInteractive: true, profile: "default" }

      const res = await applyAutoFixes(checks, opts)
      expect(res.length).toBe(1)
      expect(res[0].applied).toBe(true)
      expect(existsSync(join(cachePkgs, "flowdeck-old"))).toBe(false)
      expect(existsSync(join(cachePkgs, "other-pkg"))).toBe(true)
    } finally {
      process.env.XDG_CACHE_HOME = origCache
      process.env.XDG_DATA_HOME = origData
    }
  })
})
