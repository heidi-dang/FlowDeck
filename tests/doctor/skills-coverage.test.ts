import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { runCuratedSkillChecks } from "../../src/doctor/checks/skills"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("runCuratedSkillChecks", () => {
  const testDir = join(tmpdir(), "skill-checks-test-" + Math.random().toString(36).slice(2))

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  it("handles missing lockfile and empty skills dir", async () => {
    const checks = await runCuratedSkillChecks(testDir)
    expect(checks.some(c => c.id === "skills.lockfile" && c.status === "warning")).toBe(true)
  })

  it("handles valid lockfile and valid skills", async () => {
    const skillsDir = join(testDir, "src", "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, "skills-lock.json"), JSON.stringify({ skills: { "s1": { hash: "h1" } } }))

    const s1Dir = join(skillsDir, "s1")
    mkdirSync(s1Dir, { recursive: true })
    writeFileSync(join(s1Dir, "SKILL.md"), "---\nname: s1\ndescription: test\n---\n## Overview\n")

    const checks = await runCuratedSkillChecks(testDir)
    expect(checks.some(c => c.id === "skills.lockfile" && c.status === "pass")).toBe(true)
    expect(checks.some(c => c.id === "skills.integrity" && c.status === "pass")).toBe(true)
  })

  it("handles corrupt lockfile and invalid skills", async () => {
    const skillsDir = join(testDir, "src", "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, "skills-lock.json"), "invalid json")

    const s2Dir = join(skillsDir, "s2")
    mkdirSync(s2Dir, { recursive: true })
    writeFileSync(join(s2Dir, "SKILL.md"), "no frontmatter")

    const checks = await runCuratedSkillChecks(testDir)
    expect(checks.some(c => c.id === "skills.lockfile" && c.status === "error")).toBe(true)
    expect(checks.some(c => c.id === "skills.integrity" && c.status === "error")).toBe(true)
  })
})
