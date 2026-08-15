import type { CheckResult } from "../types";
import { CuratedSkillRegistry } from "../../services/curated-skill-registry";

export async function runCuratedSkillChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const registry = new CuratedSkillRegistry(directory);

  try {
    const lockfile = registry.getLockfile();
    const totalSkills = Object.keys(lockfile.skills).length;
    let validHashes = 0;
    let invalidSkills = 0;
    const issues: string[] = [];

    for (const [name] of Object.entries(lockfile.skills)) {
      const integrity = registry.verifySkillIntegrity(name);
      if (integrity.valid) {
        validHashes++;
      } else {
        invalidSkills++;
        issues.push(`${name}: ${integrity.reason}`);
      }
    }

    if (invalidSkills === 0) {
      checks.push({
        id: "skills.curated",
        title: "Heidi Curated Skill Subsystem",
        category: "configuration",
        severity: "low",
        status: "pass",
        detected: `${totalSkills} curated skills, ${validHashes} valid hashes, lockfile v${lockfile.version}`,
        expected: "All curated skills verified against lockfile SHA256 hashes",
        recommendation: "OK — Heidi curated skills registry is healthy and audited",
        autoFixAvailable: false,
      });
    } else {
      checks.push({
        id: "skills.curated",
        title: "Heidi Curated Skill Subsystem",
        category: "configuration",
        severity: "medium",
        status: "warning",
        detected: `${totalSkills} skills, ${validHashes} valid, ${invalidSkills} issue(s)`,
        expected: "All curated skills verified against lockfile SHA256 hashes",
        recommendation: `Integrity issues detected: ${issues.join("; ")}`,
        autoFixAvailable: false,
      });
    }
  } catch (err) {
    checks.push({
      id: "skills.curated",
      title: "Heidi Curated Skill Subsystem",
      category: "configuration",
      severity: "medium",
      status: "warning",
      detected: `Skill lockfile error: ${err instanceof Error ? err.message : String(err)}`,
      expected: "Valid skills-lock.json file present in src/skills/",
      recommendation: "Re-generate skills-lock.json using standard FlowDeck toolchain",
      autoFixAvailable: false,
    });
  }

  return checks;
}
