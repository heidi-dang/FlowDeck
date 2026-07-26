import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { runDoctorChecks } from "@/services/doctor"
import { AGENT_NAMES } from "@/agents"
import { getContract } from "@/services/agent-contract-registry"

describe("Phase 8 — CI and Production Gates", () => {
  const rootDir = process.cwd()

  describe("1. GitHub Actions Workflow File Integrity", () => {
    it(".github/workflows/ci.yml exists and contains matrix triggers", () => {
      const ciPath = join(rootDir, ".github", "workflows", "ci.yml")
      expect(existsSync(ciPath)).toBe(true)

      const content = readFileSync(ciPath, "utf-8")
      expect(content).toContain("name: CI Production Gates")
      expect(content).toContain("pull_request:")
      expect(content).toContain("ubuntu-latest")
      expect(content).toContain("windows-latest")
      expect(content).toContain("macos-latest")
    })

    it(".github/workflows/publish.yml exists and defines release tag triggers", () => {
      const pubPath = join(rootDir, ".github", "workflows", "publish.yml")
      expect(existsSync(pubPath)).toBe(true)

      const content = readFileSync(pubPath, "utf-8")
      expect(content).toContain("name: Publish to npm")
      expect(content).toContain("tags:")
    })
  })

  describe("2. Production Gate Contracts and Doctor Verification", () => {
    it("all 13 agents pass contract audit check", () => {
      expect(AGENT_NAMES.length).toBe(13)
      for (const name of AGENT_NAMES) {
        const contract = getContract(name)
        expect(contract).toBeDefined()
        expect(contract?.agent).toBe(name)
      }
    })

    it("doctor health check passes production readiness audit", () => {
      const report = runDoctorChecks(rootDir)
      expect(report.failed).toBe(0)
      expect(report.passed).toBeGreaterThan(0)
    })
  })
})
