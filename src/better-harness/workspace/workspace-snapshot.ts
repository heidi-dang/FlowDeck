import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface WorkspaceSnapshot {
  projectId: string;
  projectPath: string;
  repoName: string;
  branch: string;
  revision: string;
  dirty: boolean;
  languages: string[];
  packageManager: string;
  isMonorepo: boolean;
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  hasCI: boolean;
  hasFlowDeckConfig: boolean;
  hasOpenCodeConfig: boolean;
  capturedAt: string;
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function detectPackageManager(root: string): string {
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "unknown";
}

function detectLanguages(root: string): string[] {
  const langs = new Set<string>();
  if (existsSync(join(root, "tsconfig.json"))) langs.add("typescript");
  if (existsSync(join(root, "jsconfig.json"))) langs.add("javascript");
  if (existsSync(join(root, "go.mod"))) langs.add("go");
  if (existsSync(join(root, "Cargo.toml"))) langs.add("rust");
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.py"))) langs.add("python");
  if (existsSync(join(root, "Gemfile"))) langs.add("ruby");
  return Array.from(langs);
}

function getScriptFromPackage(root: string, name: string): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.scripts?.[name] ?? null;
  } catch {
    return null;
  }
}

function detectMonorepo(root: string): boolean {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.workspaces) return true;
  } catch { /* ignore */ }
  const monoDirs = ["packages", "apps", "modules"];
  return monoDirs.some((d) => {
    const full = join(root, d);
    if (!existsSync(full)) return false;
    try {
      return readdirSync(full).some((e) => existsSync(join(full, e)) && existsSync(join(full, e, "package.json")));
    } catch { return false; }
  });
}

function detectCI(root: string): boolean {
  const ciPaths = [
    join(root, ".github", "workflows"),
    join(root, ".gitlab-ci.yml"),
    join(root, "Jenkinsfile"),
  ];
  return ciPaths.some((p) => existsSync(p));
}

export function captureWorkspaceSnapshot(root: string): WorkspaceSnapshot {
  const revision = safeExec("git rev-parse HEAD", root);
  const branch = safeExec("git branch --show-current", root);
  const statusOutput = safeExec("git status --porcelain", root);
  const dirty = statusOutput.length > 0;
  const remoteUrl = safeExec("git config --get remote.origin.url", root);
  let repoName = root.split(/[\\/]/).pop() ?? "unknown";
  if (remoteUrl) {
    const m = remoteUrl.match(/(?:[^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m) repoName = m[1];
  }
  const pkgPath = join(root, "package.json");
  let projectId = repoName;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) projectId = pkg.name;
    } catch { /* fallback */ }
  }
  return {
    projectId,
    projectPath: root,
    repoName,
    branch,
    revision,
    dirty,
    languages: detectLanguages(root),
    packageManager: detectPackageManager(root),
    isMonorepo: detectMonorepo(root),
    buildCommand: getScriptFromPackage(root, "build"),
    testCommand: getScriptFromPackage(root, "test"),
    lintCommand: getScriptFromPackage(root, "lint"),
    hasCI: detectCI(root),
    hasFlowDeckConfig: existsSync(join(root, ".flowdeck.json")) || existsSync(join(root, ".flowdeck.jsonc")),
    hasOpenCodeConfig: existsSync(join(root, ".opencode")),
    capturedAt: new Date().toISOString(),
  };
}
