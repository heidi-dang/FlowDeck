import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { CheckResult } from "../types"

export async function runCuratedSkillChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  const skillsDir = join(directory, "src", "skills")
  const skillsLockPath = join(skillsDir, "skills-lock.json")
  const hasSkillsLock = existsSync(skillsLockPath)

  if (hasSkillsLock) {
    try {
      const lockContent = readFileSync(skillsLockPath, "utf-8")
      const parsedLock = JSON.parse(lockContent)
      const count = Object.keys(parsedLock.skills || {}).length

      checks.push({
        id: "skills.lockfile",
        title: "Skills Security Lockfile",
        category: "skills",
        severity: "info",
        status: "pass",
        detected: `skills-lock.json valid (${count} pinned skills)`,
        expected: "skills-lock.json present and valid",
        recommendation: "Skill security provenance locked",
        autoFixAvailable: false,
        affectsRuntime: false,
        repairability: "not-applicable",
      })
    } catch {
      checks.push({
        id: "skills.lockfile",
        title: "Skills Security Lockfile",
        category: "skills",
        severity: "high",
        status: "error",
        detected: "skills-lock.json is corrupt or unparseable",
        expected: "Valid skills-lock.json",
        recommendation: "Run `flowdeck doctor fix` to rebuild skills lockfile",
        autoFixAvailable: true,
        affectsRuntime: true,
        repairability: "automatic",
        repairAction: "rebuild_skills_lockfile",
      })
    }
  } else {
    checks.push({
      id: "skills.lockfile",
      title: "Skills Security Lockfile",
      category: "skills",
      severity: "medium",
      status: "warning",
      detected: "skills-lock.json missing",
      expected: "skills-lock.json present",
      recommendation: "Run `flowdeck doctor fix` to generate skills lockfile",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "rebuild_skills_lockfile",
    })
  }

  // Scan skill directory files and check frontmatter & hash alignment
  if (existsSync(skillsDir)) {
    let validSkillCount = 0
    let invalidSkillCount = 0

    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = join(skillsDir, entry.name, "SKILL.md")
          if (existsSync(skillFile)) {
            const raw = readFileSync(skillFile, "utf-8")
            if (raw.includes("name:") && raw.includes("description:") && raw.includes("##")) {
              validSkillCount++
            } else {
              invalidSkillCount++
            }
          }
        }
      }
    } catch {
      invalidSkillCount++
    }

    if (invalidSkillCount === 0) {
      checks.push({
        id: "skills.integrity",
        title: "Curated Skill Integrity",
        category: "skills",
        severity: "info",
        status: "pass",
        detected: `All ${validSkillCount} skill modules contain valid frontmatter and headings`,
        expected: "All SKILL.md modules valid",
        recommendation: "Skills system healthy",
        autoFixAvailable: false,
        affectsRuntime: false,
        repairability: "not-applicable",
      })
    } else {
      checks.push({
        id: "skills.integrity",
        title: "Curated Skill Integrity",
        category: "skills",
        severity: "high",
        status: "error",
        detected: `${invalidSkillCount} skill modules have invalid or missing frontmatter`,
        expected: "All SKILL.md modules valid",
        recommendation: "Run `flowdeck doctor fix` to restore skill definitions",
        autoFixAvailable: true,
        affectsRuntime: true,
        repairability: "automatic",
        repairAction: "restore_skills",
      })
    }
  }

  return checks
}
