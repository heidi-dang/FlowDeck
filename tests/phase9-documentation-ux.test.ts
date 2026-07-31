import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { AGENT_NAMES } from "@/agents"

describe("Phase 9 — Documentation and User Experience", () => {
  const rootDir = process.cwd()

  describe("1. Documentation Accuracy & Truth Alignment", () => {
    it("README.md contains accurate agent, skill, command counts and install URL", () => {
      const readmePath = join(rootDir, "README.md")
      expect(existsSync(readmePath)).toBe(true)

      const content = readFileSync(readmePath, "utf-8")
      expect(content).toContain("13 specialized agents")
      expect(content).toContain("61 validated skills")
      expect(content).toContain("8 slash commands")
      expect(content).toContain("heidi-dang/flowdeck/main/install.sh")
    })

    it("docs/index.md reflects current runtime truth matrix", () => {
      const docsIndexPath = join(rootDir, "docs", "index.md")
      expect(existsSync(docsIndexPath)).toBe(true)

      const content = readFileSync(docsIndexPath, "utf-8")
      expect(content).toContain("13 registered agents")
      expect(content).toContain("61 skills")
      expect(content).toContain("8 commands")
      expect(content).toContain("Heidi Primary Execution Policy")
    })

    it("CHANGELOG.md contains release notes for version 0.8.0", () => {
      const changelogPath = join(rootDir, "CHANGELOG.md")
      expect(existsSync(changelogPath)).toBe(true)

      const content = readFileSync(changelogPath, "utf-8")
      expect(content).toContain("## [0.8.0]")
      expect(content).toContain("Heidi Primary Execution Policy")
      expect(content).toContain("Native TypeScript FDX Fallbacks")
    })
  })

  describe("2. System Agent Count Verification", () => {
    it("AGENT_NAMES registry matches documented 13 agents", () => {
      expect(AGENT_NAMES.length).toBe(13)
      expect(AGENT_NAMES).toContain("heidi")
      expect(AGENT_NAMES).toContain("orchestrator")
    })
  })
})
