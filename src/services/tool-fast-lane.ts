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
 * with NO model round trip and NO shell startup. Uncertain semantics keep Shell.
 */

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

export interface FastLaneDecision {
  category: FastLaneCategory;
  usedFastPath: boolean;
  rewritten?: { from: "shell"; to: string; semanticsPreserved: true; adapter: string };
}

export function classifyFastLane(toolName: string): FastLaneDecision {
  const tool = (toolName ?? "").toLowerCase();
  if (READ_ONLY_TOOLS.has(tool)) return { category: "fast_read_only", usedFastPath: true };
  if (MUTATING_TOOLS.has(tool)) return { category: "mutating_full_governance", usedFastPath: false };
  return { category: "uncertain", usedFastPath: false };
}

export function rewriteShellCommand(command: string): NonNullable<FastLaneDecision["rewritten"]> | null {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return null;

  let m = /^cat\s+([^@|&;<>]+)$/.exec(trimmed);
  if (m) {
    const file = m[1].trim();
    if (/^[\w./~-]+$/.test(file)) {
      return { from: "shell", to: "fdx-read " + file, semanticsPreserved: true, adapter: "file-read" };
    }
  }

  m = /^sed\s+-n\s+'?([0-9]+),([0-9]+)\s*p'?\s+([\w./~-]+)$/.exec(trimmed);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const file = m[3];
    if (start > 0 && end >= start) {
      return { from: "shell", to: "fdx-read " + file + " offset=" + start + " limit=" + (end - start + 1), semanticsPreserved: true, adapter: "file-read-range" };
    }
  }

  m = /^grep\s+-n\s+([^|&;<>]+?)\s+([\w./~-]+)$/.exec(trimmed);
  if (m) {
    const pattern = m[1].trim().replace(/^['"]|['"]$/g, "");
    const file = m[2];
    if (pattern && /^[\w./~-]+$/.test(file)) {
      return { from: "shell", to: "fdx-grep pattern=" + pattern + " path=" + file, semanticsPreserved: true, adapter: "file-grep" };
    }
  }

  m = /^git\s+(status|diff|log)(.*)$/.exec(trimmed);
  if (m) {
    const sub = m[1];
    const rest = m[2] ?? "";
    if (sub === "status" && !/[^\w\s./-]/.test(rest)) return { from: "shell", to: "fdx-git status", semanticsPreserved: true, adapter: "git-status" };
    if (sub === "diff" && !/[^\w\s./ -]/.test(rest)) return { from: "shell", to: "fdx-diff" + rest, semanticsPreserved: true, adapter: "git-diff" };
    if (sub === "log" && !/[^\w\s./-]/.test(rest)) return { from: "shell", to: "fdx-git log" + rest, semanticsPreserved: true, adapter: "git-log" };
  }

  return null;
}

export function rewriteLsCommand(command: string): NonNullable<FastLaneDecision["rewritten"]> | null {
  const trimmed = (command ?? "").trim();
  if (/^ls\s+(-1\s+)?([\w./~-]+)$/.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    const target = parts[parts.length - 1];
    if (/^[\w./~-]+$/.test(target)) {
      return { from: "shell", to: "fdx-ls " + target, semanticsPreserved: true, adapter: "dir-list" };
    }
  }
  return null;
}

export { READ_ONLY_TOOLS, MUTATING_TOOLS };
