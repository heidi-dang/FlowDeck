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

    const lockData = {
      version: "2.0.3",
      updatedAt: new Date().toISOString(),
      skills: skillEntries,
    }

    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(skillsLockPath, JSON.stringify(lockData, null, 2), "utf-8")

    return {
      id: "skills.lockfile",
      description: `Rebuilt skills-lock.json with ${Object.keys(skillEntries).length} skills`,
      applied: true,
      reverified: true,
    }
  } catch (err: any) {
    return {
      id: "skills.lockfile",
      description: "Failed to repair skills lockfile",
      applied: false,
      error: err.message,
    }
  }
}
