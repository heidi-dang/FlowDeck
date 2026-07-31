import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

describe("Phase 10 — Skill Adoption and Implementation", () => {
  const rootDir = process.cwd()
  const skillsDir = join(rootDir, "src", "skills")

  const adoptedSkills = [
    "verification-before-completion",
    "systematic-debugging",
    "subagent-driven-development",
    "writing-plans",
    "executing-plans",
    "improve-codebase-architecture",
    "writing-skills",
    "workflow-skill-creator",
  ]

  it("all 8 adopted skills exist in src/skills/", () => {
    for (const name of adoptedSkills) {
      const path = join(skillsDir, name, "SKILL.md")
      expect(existsSync(path)).toBe(true)
    }
  })

  it("all 8 adopted skills contain valid YAML frontmatter and headings", () => {
    for (const name of adoptedSkills) {
      const path = join(skillsDir, name, "SKILL.md")
      const content = readFileSync(path, "utf-8")

      expect(content).toContain(`name: ${name}`)
      expect(content).toContain("description:")
      expect(content).toContain("origin:")
      expect(content).toMatch(/^##\s+/m)
    }
  })
})
