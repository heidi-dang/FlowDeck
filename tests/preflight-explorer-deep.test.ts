import { describe, it, expect } from "bun:test"
import {
  exploreRepo,
  canAnswerFromEvidence,
  shouldSuppressQuestion,
  deriveTaskContext
} from "../src/services/preflight-explorer"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Preflight Explorer Service Deep Tests", () => {
  it("exploreRepo collects comprehensive evidence from repository", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "preflight-"))
    try {
      // Setup repo structure
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "demo", dependencies: { react: "^18.0.0" } }))
      writeFileSync(join(tempDir, "AGENTS.md"), "# Agents")
      mkdirSync(join(tempDir, "src", "commands"), { recursive: true })
      writeFileSync(join(tempDir, "src", "commands", "task.md"), "# task")
      mkdirSync(join(tempDir, "src", "agents"), { recursive: true })
      writeFileSync(join(tempDir, "src", "agents", "coder.ts"), "export const coder = {}")
      mkdirSync(join(tempDir, "src", "skills", "test-skill"), { recursive: true })
      writeFileSync(join(tempDir, "src", "skills", "test-skill", "SKILL.md"), "# skill")

      const result = exploreRepo(tempDir)
      expect(result).toBeDefined()
      expect(result.hasAgentsMD).toBe(true)
      expect(result.availableCommands).toContain("task")
      expect(result.availableAgents).toContain("coder")
      expect(result.availableSkills).toContain("test-skill")
      expect(result.techStack).toContain("Node.js / JavaScript / TypeScript")
      expect(result.techStack).toContain("React")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("canAnswerFromEvidence answers tech stack and command questions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "preflight-ans-"))
    try {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "demo" }))
      const result = exploreRepo(tempDir)

      expect(canAnswerFromEvidence("What tech stack are we using?", result)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("shouldSuppressQuestion suppresses duplicate or evidence-answered questions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "preflight-sup-"))
    try {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "demo" }))
      const result = exploreRepo(tempDir)
      const history = ["What tech stack are we using?"]

      const sup1 = shouldSuppressQuestion("What tech stack are we using?", result, history)
      expect(sup1.suppress).toBe(true)

      const sup2 = shouldSuppressQuestion("What is the user's favorite color?", result, [])
      expect(sup2.suppress).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("deriveTaskContext extracts task-relevant findings and hints", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "preflight-ctx-"))
    try {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "demo" }))
      mkdirSync(join(tempDir, "src"), { recursive: true })
      writeFileSync(join(tempDir, "src", "auth.ts"), "export function auth() {}")
      const result = exploreRepo(tempDir)

      const ctx = deriveTaskContext("Fix authentication bug in auth.ts", result, tempDir)
      expect(ctx).toBeDefined()
      expect(ctx.relevantFiles.length).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
