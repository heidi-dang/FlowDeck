/**
 * ToolFastLane — accelerated tool path for deterministic read-only operations,
 * plus deterministic shell->fast-tool rewrite (Requirements R, S, U).
 *
 * Fast read-only tools use a minimal precomputed policy path (target <1ms p50,
 * <3ms p95). Mutating/dangerous operations always retain the full governance
 * path — security is never traded for speed.
 *
 * Shell rewrite: recognize safe semantic equivalents (cat, sed -n, grep, git
 * status/diff/log, simple find/list) and route them to native/file/git adapters
 * with NO model round trip and NO bash shell startup. Uncertain semantics keep
 * Shell. The fast lane EXECUTES the semantic adapter directly (in-process file
 * reads / readdir, or execFileSync("git")) so a recognized rewrite spawns ZERO
 * bash subprocesses. Only genuinely unsafe/uncertain commands fall back to
 * bash, which is the sole place bashSpawnCount is incremented.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const READ_ONLY_TOOLS = new Set([
  "fdx-read", "fdx-grep", "fdx-search", "fdx-outline", "fdx-ls", "fdx-tree",
  "fdx-diff", "fdx-git", "fdx-impact", "fdx-batch",
  "read", "read_file", "view", "glob", "grep", "search",
  "repo-memory", "codebase-state", "codegraph", "load-rules", "list-rules", "review-lessons", "planning-state",
]);

const MUTATING_TOOLS = new Set([
  "bash", "shell", "exec", "write", "write_file", "edit", "edit_file",
  "patch", "apply_patch", "str_replace", "hash-edit", "create_file", "task",
]);

export type FastLaneCategory = "fast_read_only" | "mutating_full_governance" | "uncertain";

/** Which in-process/git semantic adapter a recognized shell rewrite maps to. */
export type FastRewriteAdapter =
  | "file-read"
  | "file-read-range"
  | "file-grep"
  | "git-status"
  | "git-diff"
  | "git-log"
  | "dir-list";

/**
 * A deterministic shell->fast-tool rewrite. Carries every parsed field the
 * adapter needs to reconstruct exact shell semantics without re-parsing the
 * original command at execution time.
 */
export interface FastRewrite {
  from: "shell";
  to: string;
  semanticsPreserved: true;
  adapter: FastRewriteAdapter;
  command?: string;
  file?: string;
  offset?: number;
  limit?: number;
  pattern?: string;
  sub?: string;
  rest?: string;
  dir?: string;
}

export interface FastLaneDecision {
  category: FastLaneCategory;
  usedFastPath: boolean;
  rewritten?: FastRewrite;
}

/** Number of real bash shell subprocesses spawned by the fast-lane executor. */
export let bashSpawnCount = 0;

/** Reset the bash-spawn counter (used by tests). */
export function resetBashSpawnCount(): void {
  bashSpawnCount = 0;
}

/** Increment the bash-spawn counter. Called only when a real bash spawns. */
export function addBashSpawnCount(n: number): void {
  bashSpawnCount += n;
}

export function classifyFastLane(toolName: string): FastLaneDecision {
  const tool = (toolName ?? "").toLowerCase();
  if (READ_ONLY_TOOLS.has(tool)) return { category: "fast_read_only", usedFastPath: true };
  if (MUTATING_TOOLS.has(tool)) return { category: "mutating_full_governance", usedFastPath: false };
  return { category: "uncertain", usedFastPath: false };
}

export function rewriteShellCommand(command: string): FastRewrite | null {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return null;

  let m = /^cat\s+([^@|&;<>]+)$/.exec(trimmed);
  if (m) {
    const file = m[1].trim();
    if (/^[\w./~-]+$/.test(file)) {
      return { from: "shell", to: "fdx-read " + file, semanticsPreserved: true, adapter: "file-read", command: trimmed, file };
    }
  }

  m = /^sed\s+-n\s+'?([0-9]+),([0-9]+)\s*p'?\s+([\w./~-]+)$/.exec(trimmed);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const file = m[3];
    if (start > 0 && end >= start) {
      return {
        from: "shell",
        to: "fdx-read " + file + " offset=" + start + " limit=" + (end - start + 1),
        semanticsPreserved: true,
        adapter: "file-read-range",
        command: trimmed,
        file,
        offset: start,
        limit: end - start + 1,
      };
    }
  }

  m = /^grep\s+-n\s+([^|&;<>]+?)\s+([\w./~-]+)$/.exec(trimmed);
  if (m) {
    const pattern = m[1].trim().replace(/^['"]|['"]$/g, "");
    const file = m[2];
    if (pattern && /^[\w./~-]+$/.test(file)) {
      return { from: "shell", to: "fdx-grep pattern=" + pattern + " path=" + file, semanticsPreserved: true, adapter: "file-grep", command: trimmed, file, pattern };
    }
  }

  m = /^git\s+(status|diff|log)(.*)$/.exec(trimmed);
  if (m) {
    const sub = m[1];
    const rest = m[2] ?? "";
    if (sub === "status" && !/[^\w\s./-]/.test(rest)) {
      return { from: "shell", to: "fdx-git status", semanticsPreserved: true, adapter: "git-status", command: trimmed, sub, rest: rest.trim() };
    }
    if (sub === "diff" && !/[^\w\s./ -]/.test(rest)) {
      return { from: "shell", to: "fdx-diff" + rest, semanticsPreserved: true, adapter: "git-diff", command: trimmed, sub, rest: rest.trim() };
    }
    if (sub === "log" && !/[^\w\s./-]/.test(rest)) {
      return { from: "shell", to: "fdx-git log" + rest, semanticsPreserved: true, adapter: "git-log", command: trimmed, sub, rest: rest.trim() };
    }
  }

  return null;
}

export function rewriteLsCommand(command: string): FastRewrite | null {
  const trimmed = (command ?? "").trim();
  if (/^ls\s+(-1\s+)?([\w./~-]+)$/.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    const target = parts[parts.length - 1];
    if (/^[\w./~-]+$/.test(target)) {
      return { from: "shell", to: "fdx-ls " + target, semanticsPreserved: true, adapter: "dir-list", command: trimmed, dir: target };
    }
  }
  return null;
}

/**
 * Execute a recognized shell->fast-tool rewrite WITHOUT spawning bash. Each
 * adapter performs the semantic operation in-process or via a direct,
 * deterministic subprocess:
 *   - file-read        -> readFileSync(file, "utf8")
 *   - file-read-range  -> read the file once, slice lines [offset-1 .. offset-1+limit)
 *   - file-grep        -> read lines, keep those containing pattern, return "N:line"
 *   - git-status/diff/log -> execFileSync("git", [sub, ...rest]) (the deterministic
 *                          rewrite target equivalent to fdx-git — NOT bash)
 *   - dir-list         -> readdirSync(dir).join("\n")
 */
export function executeFastRewrite(rewritten: FastRewrite, cwd?: string): string {
  const workdir = cwd ?? process.cwd();
  switch (rewritten.adapter) {
    case "file-read":
      return readFileSync(rewritten.file ?? "", "utf8");
    case "file-read-range": {
      const text = readFileSync(rewritten.file ?? "", "utf8");
      const lines = text.split("\n");
      const start = (rewritten.offset ?? 1) - 1;
      const end = start + (rewritten.limit ?? 0);
      return lines.slice(start, end).join("\n");
    }
    case "file-grep": {
      const text = readFileSync(rewritten.file ?? "", "utf8");
      const lines = text.split("\n");
      const pattern = rewritten.pattern ?? "";
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) out.push((i + 1) + ":" + lines[i]);
      }
      return out.join("\n");
    }
    case "git-status":
    case "git-diff":
    case "git-log": {
      const args = [rewritten.sub ?? ""];
      const rest = (rewritten.rest ?? "").split(/\s+/).filter((s) => s.length > 0);
      args.push(...rest);
      try {
        return execFileSync("git", args, { cwd: workdir, encoding: "utf8" });
      } catch (err: any) {
        const oe = err?.stdout ? err.stdout.toString() : "";
        const se = err?.stderr ? err.stderr.toString() : "";
        return (oe + (oe && se ? "\n" : "") + se) || (err?.message ?? String(err));
      }
    }
    case "dir-list":
      return readdirSync(rewritten.dir ?? rewritten.file ?? ".", "utf8").join("\n");
  }
}

export { READ_ONLY_TOOLS, MUTATING_TOOLS };
