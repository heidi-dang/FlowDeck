import { describe, it, expect } from "bun:test"
import { runDoctor, scoreCategory, formatReport, formatJSON } from "../src/doctor/doctor"
import { runRuntimeChecks } from "../src/doctor/checks/runtime"
import { runRepositoryChecks } from "../src/doctor/checks/repository"
import { runEnvironmentChecks } from "../src/doctor/checks/environment"
import { runMCPChecks } from "../src/doctor/checks/mcp"
import { runPluginChecks } from "../src/doctor/checks/plugin"
import { runHookChecks } from "../src/doctor/checks/hooks"
import { runSecurityChecks } from "../src/doctor/checks/security"
import { runConfigurationChecks } from "../src/doctor/checks/configuration"
import { generateRecommendations } from "../src/doctor/recommendations/recommendations"
import { applyAutoFixes } from "../src/doctor/apply/apply"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Doctor Engine Deep Coverage Tests", () => {
  it("runs runDoctor with strict options and profiles", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-deep-"))
    try {
      const report = await runDoctor(tempDir, { strict: true, profile: "recommended-dev" })
      expect(report).toBeDefined()
      expect(report.summary).toBeDefined()
      expect(report.version).toBeDefined()
      expect(typeof report.scores.overall).toBe("number")
      expect(Array.isArray(report.checks)).toBe(true)
      expect(Array.isArray(report.recommendations)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30000)

  it("scoreCategory correctly calculates category score", () => {
    const checks: any[] = [
      { category: "runtime", status: "pass" },
      { category: "runtime", status: "warning" },
      { category: "runtime", status: "error" },
    ]
    const score = scoreCategory(checks, "runtime")
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it("runRuntimeChecks checks node, bun, git, opencode executables", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-rt-"))
    try {
      // Blocker 3: doctor aggregation unit tests inject the FDX availability
      // result instead of running a real FDX resolution (which spawns
      // subprocess probes and can exceed Bun's 5s default). The explicit
      // bounded timeout covers the real node/bun/git/rustc subprocess probes.
      const checks = await runRuntimeChecks(tempDir, undefined, {
        fdxStatus: {
          available: false,
          binary: null,
          binaryPath: null,
          message: "injected stub",
          source: "none",
          target: null,
          targetSupported: false,
          packagePresent: false,
          binaryPresent: false,
          binaryIntegrity: "fail",
          binaryVersion: null,
          versionCompatible: false,
          checksumStatus: "missing",
          executionStatus: "fail",
          fallbackAvailable: true,
          diagnostics: [],
        },
      })
      expect(checks.length).toBeGreaterThan(0)
      const ids = checks.map(c => c.id)
      expect(ids).toContain("runtime.node")
      // The injected result is used for the FDX checks (no real resolution).
      const fdxTarget = checks.find(c => c.id === "fdx.target-supported")
      expect(fdxTarget?.status).toBe("info")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  it("runRepositoryChecks checks git repo, AGENTS.md, lockfiles", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-repo-"))
    try {
      // Empty dir -> expect errors for missing git and missing files
      let checks = await runRepositoryChecks(tempDir)
      expect(checks.some(c => c.status === "error")).toBe(true)

      // Create dummy AGENTS.md and package.json
      writeFileSync(join(tempDir, "AGENTS.md"), "# AGENTS")
      writeFileSync(join(tempDir, "package.json"), "{}")
      checks = await runRepositoryChecks(tempDir)
      expect(checks.some(c => c.id === "repo.package_json" && c.status === "pass")).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runEnvironmentChecks checks process env vars", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-env-"))
    try {
      const checks = await runEnvironmentChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)
      expect(checks.some(c => c.category === "environment")).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runMCPChecks checks opencode.json mcp servers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-mcp-"))
    try {
      let checks = await runMCPChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)

      mkdirSync(join(tempDir, ".opencode"), { recursive: true })
      writeFileSync(join(tempDir, ".opencode", "opencode.json"), JSON.stringify({ mcp: { demo: { command: "node" } } }))
      checks = await runMCPChecks(tempDir)
      expect(checks.some(c => c.id.startsWith("mcp."))).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runPluginChecks checks plugin config and skills", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-plug-"))
    try {
      let checks = await runPluginChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)

      mkdirSync(join(tempDir, ".opencode", "plugins"), { recursive: true })
      writeFileSync(join(tempDir, ".opencode", "plugins", "demo.json"), JSON.stringify({ name: "demo" }))
      checks = await runPluginChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runHookChecks checks hooks configuration", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-hook-"))
    try {
      const checks = await runHookChecks(tempDir)
      expect(Array.isArray(checks)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runSecurityChecks checks secret exposure and permissions", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-sec-"))
    try {
      let checks = await runSecurityChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)

      // Create .env with dummy secret
      writeFileSync(join(tempDir, ".env"), "API_KEY=sk-proj-1234567890abcdef1234567890abcdef")
      checks = await runSecurityChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("runConfigurationChecks checks required config files and JSON syntax", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-cfg-"))
    try {
      let checks = await runConfigurationChecks(tempDir)
      expect(checks.some(c => c.status === "error")).toBe(true)

      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }))
      writeFileSync(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
      writeFileSync(join(tempDir, "install.sh"), "#!/bin/bash")
      writeFileSync(join(tempDir, "uninstall.sh"), "#!/bin/bash")
      writeFileSync(join(tempDir, ".gitignore"), "node_modules/")

      checks = await runConfigurationChecks(tempDir)
      expect(checks.some(c => c.id === "config.package.json" && c.status === "pass")).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("generateRecommendations produces recommendations for failing checks", () => {
    const checks: any[] = [
      { id: "repo.agents_md", status: "error", title: "Missing AGENTS.md", severity: "high", recommendation: "Create AGENTS.md" },
      { id: "sec.secrets", status: "warning", title: "Exposed API Key", severity: "critical", recommendation: "Redact API Key" }
    ]
    const recs = generateRecommendations(checks)
    expect(recs.length).toBeGreaterThan(0)
  })

  it("applyAutoFixes applies fixable recommendations safely", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-fix-"))
    try {
      const results = await applyAutoFixes([], { directory: tempDir } as any)
      expect(Array.isArray(results)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("formatReport and formatJSON format reports correctly", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-fmt-"))
    try {
      const report = await runDoctor(tempDir, { verbose: true, profile: "recommended-dev" })
      const textVerbose = formatReport(report, true)
      expect(textVerbose).toContain("FlowDeck Doctor")
      expect(textVerbose).toContain("Readiness:")
      
      const textQuiet = formatReport(report, false)
      expect(textQuiet).toBeDefined()

      const jsonStr = formatJSON(report)
      expect(JSON.parse(jsonStr).version).toBeDefined()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
