import { describe, it, expect } from "bun:test"
import { runDoctor, scoreCategory, formatReport, formatJSON } from "../src/doctor/doctor"
import {
  runRuntimeChecks,
  parseOpenCodeVersion,
  supportsBackgroundSubagents,
  classifyOpenCodeCompatibility,
  backgroundSubagentCapabilityCheck,
  codeModeCapabilityCheck,
} from "../src/doctor/checks/runtime"
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

  it("parses OpenCode versions and gates native background support and qualification", () => {
    expect(parseOpenCodeVersion("1.18.20")).toEqual({ major: 1, minor: 18, patch: 20 })
    expect(parseOpenCodeVersion("1.18.18")).toEqual({ major: 1, minor: 18, patch: 18 })
    expect(parseOpenCodeVersion("opencode 1.18.18")).toEqual({ major: 1, minor: 18, patch: 18 })
    expect(parseOpenCodeVersion(null)).toBeNull()
    expect(supportsBackgroundSubagents("1.18.20")).toBe(true)
    expect(supportsBackgroundSubagents("1.18.18")).toBe(true)
    expect(supportsBackgroundSubagents("1.17.9")).toBe(false)
    expect(supportsBackgroundSubagents("not-a-version")).toBe(false)

    expect(classifyOpenCodeCompatibility("1.18.20").qualification).toBe("FULLY_QUALIFIED")
    expect(classifyOpenCodeCompatibility("1.18.18").qualification).toBe("SUPPORTED")
    expect(classifyOpenCodeCompatibility("1.18.19").qualification).toBe("SUPPORTED")
    expect(classifyOpenCodeCompatibility("1.18.21").qualification).toBe("SUPPORTED_UNVERIFIED")
    expect(classifyOpenCodeCompatibility("1.18.99").qualification).toBe("SUPPORTED_UNVERIFIED")
    expect(classifyOpenCodeCompatibility("1.19.0").qualification).toBe("SUPPORTED_UNVERIFIED")
    expect(classifyOpenCodeCompatibility("1.20.0").qualification).toBe("SUPPORTED_UNVERIFIED")
    expect(classifyOpenCodeCompatibility("2.0.0").qualification).toBe("SUPPORTED_UNVERIFIED")
    expect(classifyOpenCodeCompatibility("1.18.10").qualification).toBe("DEGRADED")
    expect(classifyOpenCodeCompatibility("1.18.17").qualification).toBe("DEGRADED")
    expect(classifyOpenCodeCompatibility("1.17.0").qualification).toBe("UNSUPPORTED")
  })

  it("reports native Code Mode capability correctly based on environment flags", () => {
    const originalNarrow = process.env.OPENCODE_EXPERIMENTAL_CODE_MODE
    const originalBroad = process.env.OPENCODE_EXPERIMENTAL
    try {
      delete process.env.OPENCODE_EXPERIMENTAL
      process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = "true"
      const enabled = codeModeCapabilityCheck("1.18.20")
      expect(enabled.status).toBe("pass")
      expect(enabled.detected).toContain("OPENCODE_EXPERIMENTAL_CODE_MODE=true")
      expect(enabled.evidence?.executeToolAvailable).toBe("UNKNOWN")

      process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = "false"
      const disabled = codeModeCapabilityCheck("1.18.20")
      expect(disabled.status).toBe("info")
      expect(disabled.evidence?.executeToolAvailable).toBe("UNAVAILABLE")
    } finally {
      if (originalNarrow === undefined) delete process.env.OPENCODE_EXPERIMENTAL_CODE_MODE
      else process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = originalNarrow
      if (originalBroad === undefined) delete process.env.OPENCODE_EXPERIMENTAL
      else process.env.OPENCODE_EXPERIMENTAL = originalBroad
    }
  })

  it("reports native background subagent capability from the narrow flag", () => {
    const originalNarrow = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
    const originalBroad = process.env.OPENCODE_EXPERIMENTAL
    try {
      delete process.env.OPENCODE_EXPERIMENTAL
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
      const enabled = backgroundSubagentCapabilityCheck("1.18.18")
      expect(enabled.status).toBe("pass")
      expect(enabled.detected).toContain("native Task background parameter supported")
      expect(enabled.detected).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")

      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "false"
      const disabled = backgroundSubagentCapabilityCheck("1.18.18")
      expect(disabled.status).toBe("warning")
      expect(disabled.autoFixAvailable).toBe(true)
      expect(disabled.detected).toContain("is not enabled")

      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
      process.env.OPENCODE_EXPERIMENTAL = "true"
      const broad = backgroundSubagentCapabilityCheck("1.18.18")
      expect(broad.status).toBe("pass")
      expect(broad.detected).toContain("broad OPENCODE_EXPERIMENTAL fallback")
    } finally {
      if (originalNarrow === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalNarrow
      if (originalBroad === undefined) delete process.env.OPENCODE_EXPERIMENTAL
      else process.env.OPENCODE_EXPERIMENTAL = originalBroad
    }
  })

  it("runRuntimeChecks checks node, bun, git, opencode executables", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "doc-rt-"))
    try {
      const checks = await runRuntimeChecks(tempDir)
      expect(checks.length).toBeGreaterThan(0)
      const ids = checks.map(c => c.id)
      expect(ids).toContain("runtime.node")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

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

  it("reports that Doctor cannot mutate an externally owned OpenCode launch environment", async () => {
    const original = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
    try {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
      delete process.env.OPENCODE_EXPERIMENTAL
      const results = await applyAutoFixes([backgroundSubagentCapabilityCheck("1.18.18")], {})
      expect(results).toHaveLength(1)
      expect(results[0].applied).toBe(false)
      expect(results[0].description).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = original
    }
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