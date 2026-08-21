/**
 * GovernanceFastPath — Accelerated authorization for safe, read-only operations.
 *
 * Whitelisted read-only tools bypass full multi-rule governance evaluation,
 * delivering < 5 ms p50 (target < 2 ms) authorization overhead.
 *
 * ALL writes, shell mutations, deletions, and credential ops go through
 * the full strict governance path — no exceptions.
 */

export type GovernanceMode = "off" | "advisory" | "strict"

/** Tools that are unconditionally safe to skip full policy evaluation for. */
const READ_ONLY_TOOLS = new Set([
  "fdx-read",
  "fdx-grep",
  "fdx-search",
  "fdx-outline",
  "fdx-ls",
  "fdx-tree",
  "fdx-diff",
  "fdx-git",
  "fdx-impact",
  "fdx-context",
  "fdx-decisions",
  "fdx-batch",
  "fdx-validate",
  "fdx-worktree",
  "repo-memory",
  "codebase-state",
  "codegraph",
  "load-rules",
  "list-rules",
  "review-lessons",
  "planning-state",
])

/** Tools that ALWAYS require full policy evaluation. */
const HIGH_RISK_TOOLS = new Set([
  "bash",
  "shell",
  "exec",
  "write",
  "edit",
  "apply_patch",
  "str_replace",
  "task",
  "computer",
])

export interface FastPathResult {
  /** Whether the tool is allowed to proceed. */
  allowed: boolean
  /** Whether the fast path was used (vs full evaluation). */
  usedFastPath: boolean
  /** Reason for block, if any. */
  reason?: string
}

/**
 * Authorize a tool call, using the fast path for proven read-only tools.
 *
 * Fast path rules:
 *   - mode "off": always allow without checking anything.
 *   - mode "advisory" or "strict" + read-only tool: allow via fast path.
 *   - mode "advisory" or "strict" + high-risk tool: must go through full evaluation.
 *   - Unknown tools with no strong signals: treated as needing full evaluation.
 *
 * @param tool       Tool name.
 * @param mode       Resolved governance mode for the session.
 * @param pathHint   Optionally the path being operated on (used to detect root writes).
 */
export function governanceFastPath(
  tool: string,
  mode: GovernanceMode,
  pathHint?: string,
): FastPathResult {
  // governance off: everything allowed
  if (mode === "off") {
    return { allowed: true, usedFastPath: true }
  }

  // High-risk tools always need full evaluation
  if (HIGH_RISK_TOOLS.has(tool)) {
    return { allowed: false, usedFastPath: false, reason: "HIGH_RISK_TOOL_REQUIRES_FULL_POLICY" }
  }

  // Safe read tools: fast-path allow
  if (READ_ONLY_TOOLS.has(tool)) {
    // Extra guard: never fast-path operations targeting filesystem root
    if (pathHint && (pathHint === "/" || pathHint === "\\" || /^[a-zA-Z]:[/\\]?$/.test(pathHint))) {
      return { allowed: false, usedFastPath: false, reason: "FILESYSTEM_ROOT_OPERATION_BLOCKED" }
    }
    return { allowed: true, usedFastPath: true }
  }

  // Unknown tool: must evaluate via full path
  return { allowed: false, usedFastPath: false, reason: "UNKNOWN_TOOL_REQUIRES_FULL_POLICY" }
}

/** Check if a tool is a known safe read tool. */
export function isSafeReadTool(tool: string): boolean {
  return READ_ONLY_TOOLS.has(tool)
}

/** Check if a tool requires full governance evaluation. */
export function isHighRiskTool(tool: string): boolean {
  return HIGH_RISK_TOOLS.has(tool)
}
