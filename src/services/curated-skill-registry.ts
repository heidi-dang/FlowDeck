/**
 * Curated Skill Registry & Security Subsystem for Heidi / FlowDeck v2.0.1
 *
 * Manages project-controlled skill lockfile, SHA256 integrity checks, static security audits,
 * authority enforcement, conflict resolution, lazy routing, and context budgeting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type SkillAuthority = "advisory" | "procedure" | "specialist";
export type SkillSecurityStatus =
  | "trusted-curated"
  | "allowed-with-restrictions"
  | "quarantined"
  | "disabled";

export interface CuratedSkillEntry {
  name: string;
  source: string;
  revision: string;
  path: string;
  sha256: string;
  authority: SkillAuthority;
  priority: number;
  intents: string[];
  tags: string[];
  securityStatus: SkillSecurityStatus;
  mayOverrideExecutionPolicy: false;
  mayMarkTaskComplete: false;
  mayCommit: boolean;
  mayDeploy: boolean;
  mutuallyExclusiveWith?: string[];
  complements?: string[];
}

export interface SkillLockfile {
  version: string;
  updatedAt: string;
  skills: Record<string, CuratedSkillEntry>;
}

export interface SkillAuditResult {
  passed: boolean;
  securityStatus: SkillSecurityStatus;
  reasons: string[];
}

export interface LazyResolveOptions {
  taskPrompt: string;
  packageManager?: "bun" | "npm" | "pnpm" | "yarn";
  maxTokenBudget?: number;
  projectRoot?: string;
}

export interface LazyResolveResult {
  loadedSkills: CuratedSkillEntry[];
  skillsContent: Array<{ name: string; content: string }>;
  totalLines: number;
  totalEstimatedTokens: number;
  quarantinedOrDisabled: string[];
}

export class CuratedSkillRegistry {
  private projectRoot: string;
  private lockfile: SkillLockfile | null = null;
  private quarantinedCandidates = new Map<string, { source: string; discoveredAt: string }>();

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ? resolve(projectRoot) : process.cwd();
  }

  /**
   * Load and return the skills lockfile.
   */
  public getLockfile(): SkillLockfile {
    if (this.lockfile) return this.lockfile;

    const lockPath = join(this.projectRoot, "src", "skills", "skills-lock.json");
    if (!existsSync(lockPath)) {
      throw new Error(`Skills lockfile not found at ${lockPath}`);
    }

    try {
      const raw = readFileSync(lockPath, "utf-8");
      this.lockfile = JSON.parse(raw) as SkillLockfile;
      return this.lockfile;
    } catch (err) {
      throw new Error(`Failed to parse skills lockfile: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Verify SHA256 integrity of a skill against the lockfile.
   */
  public verifySkillIntegrity(skillName: string): { valid: boolean; reason?: string; computedHash?: string } {
    const lockfile = this.getLockfile();
    const entry = lockfile.skills[skillName];

    if (!entry) {
      return { valid: false, reason: `Skill "${skillName}" not found in lockfile` };
    }

    const fullPath = join(this.projectRoot, entry.path);
    if (!existsSync(fullPath)) {
      return { valid: false, reason: `Skill file missing at ${fullPath}` };
    }

    try {
      const content = readFileSync(fullPath);
      const computedHash = createHash("sha256").update(content).digest("hex");

      if (computedHash !== entry.sha256) {
        return {
          valid: false,
          reason: `SHA256 hash mismatch for skill "${skillName}" (expected: ${entry.sha256.slice(0, 8)}, computed: ${computedHash.slice(0, 8)})`,
          computedHash,
        };
      }

      return { valid: true, computedHash };
    } catch (err) {
      return { valid: false, reason: `Read error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Perform static security audit of skill instructions.
   */
  public auditSkillSecurity(skillContent: string): SkillAuditResult {
    const reasons: string[] = [];
    const lower = skillContent.toLowerCase();

    // 1. Detect attempts to override Heidi policy or completion
    if (lower.includes("mayoverrideexecutionpolicy: true") || lower.includes("override execution policy")) {
      reasons.push("Attempt to override Heidi execution policy");
    }
    if (lower.includes("maymarktaskcomplete: true") || lower.includes("mark task complete directly")) {
      reasons.push("Attempt to grant unauthorized task completion authority");
    }

    // 2. Detect un-audited command execution or credentials
    if (lower.includes("curl ") && lower.includes("| bash")) {
      reasons.push("Unsafe un-audited script piping (curl | bash)");
    }
    if (lower.includes("eval(") || lower.includes("eval ")) {
      reasons.push("Unsafe dynamic eval execution");
    }

    // 3. Detect unauthorized production deployment or git push
    if (lower.includes("git push origin main") || lower.includes("deploy --production")) {
      reasons.push("Unauthorized production deployment/push instruction");
    }

    if (reasons.length > 0) {
      return {
        passed: false,
        securityStatus: "quarantined",
        reasons,
      };
    }

    return {
      passed: true,
      securityStatus: "trusted-curated",
      reasons: [],
    };
  }

  /**
   * Quarantine a newly discovered skill candidate from find-skills.
   * Discovered skills enter quarantine state and CANNOT auto-load until audited and pinned.
   */
  public quarantineDiscoveredSkill(skillName: string, source: string): void {
    this.quarantinedCandidates.set(skillName, {
      source,
      discoveredAt: new Date().toISOString(),
    });
  }

  public getQuarantinedSkills(): string[] {
    return Array.from(this.quarantinedCandidates.keys());
  }

  /**
   * Resolve minimal complementary skill set for a user prompt cleanly.
   */
  public resolveLazySkills(options: LazyResolveOptions): LazyResolveResult {
    const lockfile = this.getLockfile();
    const taskText = options.taskPrompt.toLowerCase();
    const pkgManager = options.packageManager || "npm";

    const matchedEntries: CuratedSkillEntry[] = [];
    const quarantinedOrDisabled: string[] = [];

    for (const [name, entry] of Object.entries(lockfile.skills)) {
      // 1. Integrity check
      const integrity = this.verifySkillIntegrity(name);
      if (!integrity.valid) {
        quarantinedOrDisabled.push(`${name} (integrity: ${integrity.reason})`);
        continue;
      }

      // 2. Security status check
      if (entry.securityStatus === "disabled" || entry.securityStatus === "quarantined") {
        quarantinedOrDisabled.push(`${name} (${entry.securityStatus})`);
        continue;
      }

      // 3. Package manager gating (e.g. Bun skill loads ONLY when project uses Bun)
      if (name === "bun" && pkgManager !== "bun") {
        continue;
      }

      // 4. Intent & Tag Matching
      const matchesIntent = entry.intents.some((intent) => taskText.includes(intent.toLowerCase()));
      const matchesTag = entry.tags.some((tag) => taskText.includes(tag.toLowerCase()));
      const matchesName = taskText.includes(name.toLowerCase());

      // Specific intent mapping helpers
      let matchesContext = false;

      const isUiTask = taskText.includes("redesign") || taskText.includes("settings page") || taskText.includes("layout") || taskText.includes("ui") || taskText.includes("theme");
      const isMcpBuildTask = (taskText.includes("mcp server") || taskText.includes("add mcp") || taskText.includes("build mcp")) && !isUiTask;
      const isBrowserDebugTask = taskText.includes("console bug") || taskText.includes("browser error") || taskText.includes("react error") || taskText.includes("debug the website") || taskText.includes("fix all console bugs");
      const isCiTask = taskText.includes("github action") || taskText.includes("workflow is failing");

      if (isBrowserDebugTask) {
        if (["systematic-debugging", "agent-browser", "tdd-workflow", "verification-before-completion", "heidi-browser-debugging"].includes(name)) {
          matchesContext = true;
        }
      } else if (isUiTask) {
        if (["frontend-design", "vercel-react-best-practices", "vercel-composition-patterns", "web-design-guidelines", "verification-before-completion"].includes(name)) {
          matchesContext = true;
        }
      } else if (isMcpBuildTask) {
        if (["mcp-builder", "mcp-security-audit", "secret-scanning", "verification-before-completion"].includes(name)) {
          matchesContext = true;
        }
      } else if (isCiTask) {
        if (["systematic-debugging", "github-actions-hardening", "github-actions-efficiency", "verification-before-completion"].includes(name)) {
          matchesContext = true;
        }
      } else {
        matchesContext = matchesIntent || matchesTag || matchesName;
      }

      if (matchesContext) {
        matchedEntries.push(entry);
      }
    }

    // 5. Conflict Resolution & Deduplication (Sort by priority descending)
    matchedEntries.sort((a, b) => b.priority - a.priority);

    const finalSkills: CuratedSkillEntry[] = [];
    const seenNames = new Set<string>();

    for (const entry of matchedEntries) {
      if (seenNames.has(entry.name)) continue;

      // Check mutual exclusion
      const isExcluded = finalSkills.some((s) => s.mutuallyExclusiveWith?.includes(entry.name));
      if (isExcluded) continue;

      seenNames.add(entry.name);
      finalSkills.push(entry);
    }

    // 6. Context Budgeting (max tokens/lines across loaded skills)
    const maxTokenBudget = options.maxTokenBudget || 4000;
    const skillsContent: Array<{ name: string; content: string }> = [];
    let totalLines = 0;
    let totalEstimatedTokens = 0;

    for (const entry of finalSkills) {
      try {
        const fullPath = join(this.projectRoot, entry.path);
        const raw = readFileSync(fullPath, "utf-8");
        const lines = raw.split("\n").length;
        const estTokens = Math.round(raw.length / 4);

        if (totalEstimatedTokens + estTokens > maxTokenBudget && skillsContent.length > 0) {
          // Exceeds context budget — stop adding additional skills
          break;
        }

        skillsContent.push({ name: entry.name, content: raw });
        totalLines += lines;
        totalEstimatedTokens += estTokens;
      } catch {
        /* ignore read error */
      }
    }

    return {
      loadedSkills: finalSkills.slice(0, skillsContent.length),
      skillsContent,
      totalLines,
      totalEstimatedTokens,
      quarantinedOrDisabled,
    };
  }
}
