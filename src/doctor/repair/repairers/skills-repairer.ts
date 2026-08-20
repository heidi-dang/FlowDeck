import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { AutoFixResult } from "../../types"

export async function repairSkillsAndLockfile(directory: string): Promise<AutoFixResult> {
  const skillsDir = join(directory, "src", "skills")
  const skillsLockPath = join(skillsDir, "skills-lock.json")

  try {
    const skillEntries: Record<string, { path: string; hash: string }> = {}

    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = join(skillsDir, entry.name, "SKILL.md")
          if (existsSync(skillFile)) {
            const raw = readFileSync(skillFile, "utf-8")
            const hash = createHash("sha256").update(raw).digest("hex")
            skillEntries[entry.name] = {
              path: `src/skills/${entry.name}/SKILL.md`,
              hash,
            }
          }
        }
      }
    }

    let existingMatches = false
    if (existsSync(skillsLockPath)) {
      try {
        const existing = JSON.parse(readFileSync(skillsLockPath, "utf-8"))
        if (existing && typeof existing.skills === "object") {
          const exKeys = Object.keys(existing.skills).sort()
          const newKeys = Object.keys(skillEntries).sort()
          if (exKeys.length === newKeys.length && exKeys.every((k, i) => k === newKeys[i] && existing.skills[k]?.hash === skillEntries[k]?.hash)) {
            existingMatches = true
          }
        }
      } catch {}
    }

    if (!existingMatches) {
      const lockData = {
        version: "2.0.3",
        updatedAt: new Date().toISOString(),
        skills: skillEntries,
      }
      mkdirSync(skillsDir, { recursive: true })
      writeFileSync(skillsLockPath, JSON.stringify(lockData, null, 2), "utf-8")
    }

    // Post-repair verification: skills-lock.json exists and is valid JSON
    let reverified = false
    try {
      const readBack = JSON.parse(readFileSync(skillsLockPath, "utf-8"))
      reverified = Boolean(readBack && typeof readBack.skills === "object")
    } catch {
      reverified = false
    }

    return {
      id: "skills.lockfile",
      description: existingMatches
        ? `Skills lockfile is healthy (${Object.keys(skillEntries).length} skills verified)`
        : `Rebuilt skills-lock.json with ${Object.keys(skillEntries).length} skills`,
      applied: reverified,
      reverified,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "skills.lockfile",
      description: "Failed to repair skills lockfile",
      applied: false,
      reverified: false,
      error: message,
    }
  }
}
