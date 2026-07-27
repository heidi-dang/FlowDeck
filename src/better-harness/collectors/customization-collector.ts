import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { HarnessEvidence } from "../contracts/report";
import { normalizeEvidence, type RawCollectorEvidence } from "../evidence/evidence-normalizer";

export function collectCustomizationEvidence(root: string): HarnessEvidence[] {
  const raw: RawCollectorEvidence[] = [];

  // Check config files
  const configFiles = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "opencode.json", "opencode.jsonc", ".flowdeck.json", ".flowdeck.jsonc"];
  for (const file of configFiles) {
    const full = join(root, file);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8");
        raw.push({
          category: "customization",
          source: file,
          summary: `Found ${file} (${content.length} chars)`,
          path: full,
          confidence: 1.0,
        });
      } catch {
        raw.push({
          category: "customization",
          source: file,
          summary: `Found ${file} (unreadable)`,
          path: full,
          confidence: 0.5,
        });
      }
    }
  }

  // Check .opencode/ directory
  const opencodeDir = join(root, ".opencode");
  if (existsSync(opencodeDir)) {
    try {
      const entries = readdirSync(opencodeDir);
      raw.push({
        category: "customization",
        source: ".opencode/",
        summary: `Found .opencode directory with ${entries.length} entries`,
        path: opencodeDir,
        confidence: 1.0,
      });
    } catch { /* ignore */ }
  }

  // Check agents directory
  const agentsDir = join(root, "src", "agents");
  if (existsSync(agentsDir)) {
    try {
      const files = readdirSync(agentsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".md"));
      if (files.length > 0) {
        raw.push({
          category: "customization",
          source: "src/agents/",
          summary: `Found ${files.length} agent definitions`,
          path: agentsDir,
          confidence: 1.0,
        });
      }
    } catch { /* ignore */ }
  }

  // Check skills, commands, rules, hooks
  const assetDirs = [
    ["src/skills/", "skills"],
    ["src/commands/", "commands"],
    ["src/rules/", "rules"],
    ["src/hooks/", "hooks"],
    ["scripts/", "scripts"],
    [".github/", "workflows"],
  ] as const;

  for (const [dir, label] of assetDirs) {
    const full = join(root, dir);
    if (existsSync(full)) {
      try {
        const files = readdirSync(full);
        raw.push({
          category: "customization",
          source: dir,
          summary: `Found ${files.length} ${label}`,
          path: full,
          confidence: 1.0,
        });
      } catch { /* ignore */ }
    }
  }

  return normalizeEvidence(raw);
}

export const customizationCollector = {
  name: "customization" as const,
  collect: collectCustomizationEvidence,
};
