import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadFlowDeckConfig } from "../../config/agent-models";

export interface ProjectIdentity {
  projectId: string;
  name: string;
  directory: string;
  source: "flowdeck-config" | "package-name" | "directory-hash";
}

function hashDirectory(dir: string): string {
  return createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 16);
}

export function getProjectIdentity(root: string): ProjectIdentity {
  // First: try FlowDeck config
  const flowdeckConfig = loadFlowDeckConfig(root);
  const fdPath = [
    join(root, ".flowdeck.jsonc"),
    join(root, ".flowdeck.json"),
    join(root, ".opencode", "flowdeck.jsonc"),
    join(root, ".opencode", "flowdeck.json"),
  ];

  for (const p of fdPath) {
    if (existsSync(p)) {
      return {
        projectId: hashDirectory(root),
        name: flowdeckConfig.agentModels ? root.split(/[\\/]/).pop() ?? "project" : root.split(/[\\/]/).pop() ?? "project",
        directory: root,
        source: "flowdeck-config",
      };
    }
  }

  // Second: try package.json name
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) {
        return {
          projectId: hashDirectory(root),
          name: pkg.name,
          directory: root,
          source: "package-name",
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: directory hash
  const dirName = root.split(/[\\/]/).pop() ?? "unknown";
  return {
    projectId: hashDirectory(root),
    name: dirName,
    directory: root,
    source: "directory-hash",
  };
}
