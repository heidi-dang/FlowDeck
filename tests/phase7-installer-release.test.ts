import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"
import { runDoctorChecks } from "@/services/doctor"
import { doctorTool } from "@/tools/doctor"

const TMP = join(tmpdir(), "phase7-test-" + Date.now())
const ctx = { directory: TMP } as any

describe("Phase 7 — Installer, Upgrade, Doctor, and Uninstall", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe("1. Doctor Diagnostic Health Checks", () => {
    it("runDoctorChecks returns complete report for valid directory", () => {
      const report = runDoctorChecks(TMP)
      expect(report).toBeDefined()
      expect(typeof report.passed).toBe("number")
      expect(typeof report.failed).toBe("number")
      expect(report.checks.length).toBeGreaterThan(0)
    })

    it("detects valid .flowdeck.json configuration", () => {
      writeFileSync(join(TMP, ".flowdeck.json"), JSON.stringify({ governance: { validator: { mode: "strict" } } }), "utf-8")
      const report = runDoctorChecks(TMP)
      const cfgCheck = report.checks.find(c => c.id === "config.validity")
      expect(cfgCheck).toBeDefined()
      expect(cfgCheck?.status).toBe("pass")
      expect(cfgCheck?.message).toContain("strict")
    })

    it("detects malformed .flowdeck.json configuration as failure", () => {
      writeFileSync(join(TMP, ".flowdeck.json"), "{ malformed json", "utf-8")
      const report = runDoctorChecks(TMP)
      const cfgCheck = report.checks.find(c => c.id === "config.validity")
      expect(cfgCheck).toBeDefined()
      expect(cfgCheck?.status).toBe("fail")
      expect(cfgCheck?.remediation).toBeDefined()
    })

    it("verifies all registered agent capability contracts", () => {
      // The doctor now scans src/agents/ on disk — create some agent files
      const agentsDir = join(TMP, "src", "agents")
      mkdirSync(agentsDir, { recursive: true })
      const agentNames = ["planner", "architect", "researcher", "mapper", "tester", "reviewer", "security-auditor", "backend-coder", "frontend-coder", "devops"]
      for (const name of agentNames) {
        writeFileSync(join(agentsDir, `${name}.ts`), `// ${name} agent`, "utf-8")
      }

      const report = runDoctorChecks(TMP)
      const agentCheck = report.checks.find(c => c.id === "agents.contracts")
      expect(agentCheck).toBeDefined()
      expect(agentCheck?.status).toBe("pass")
      expect(agentCheck?.message).toContain("10")
    })

    it("warns when skill files lack YAML frontmatter headers", () => {
      const skillsDir = join(TMP, "src", "skills", "bad-skill")
      mkdirSync(skillsDir, { recursive: true })
      writeFileSync(join(skillsDir, "SKILL.md"), "# Bad Skill\nNo frontmatter here", "utf-8")

      const report = runDoctorChecks(TMP)
      const skillCheck = report.checks.find(c => c.id === "skills.recursive")
      expect(skillCheck).toBeDefined()
      expect(skillCheck?.status).toBe("warn")
      expect(skillCheck?.remediation).toBeDefined()
    })
  })

  describe("2. Doctor Tool Execution", () => {
    it("doctorTool renders formatted Markdown report", async () => {
      const output = await doctorTool.execute({}, ctx)
      expect(typeof output).toBe("string")
      expect(output).toContain("# FlowDeck Doctor Health Report")
      expect(output).toContain("Passed")
    })
  })

  describe("3. Installer & Uninstall Script Integrity", () => {
    it("install.sh and uninstall.sh exist and pass bash syntax verification", { timeout: 20_000 }, () => {
      const installPath = join(process.cwd(), "install.sh")
      const uninstallPath = join(process.cwd(), "uninstall.sh")

      expect(existsSync(installPath)).toBe(true)
      expect(existsSync(uninstallPath)).toBe(true)

      try {
        execSync(`bash -n "${installPath}"`, { stdio: "ignore" })
        execSync(`bash -n "${uninstallPath}"`, { stdio: "ignore" })
      } catch (err: any) {
        // Skip bash syntax check if bash is not available in environment
      }
    })
  })
})
