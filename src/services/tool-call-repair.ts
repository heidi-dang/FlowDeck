/**
 * ToolCallRepairService — Deterministic, rule-based repair of mechanical tool call anomalies.
 *
 * Handles ONLY structural/mechanical issues:
 *   - Known argument aliases (path vs file_path, cmd vs command)
 *   - Path separator normalization (Windows backslashes -> POSIX)
 *   - Scalar vs array normalization (files: "foo" -> files: ["foo"])
 *
 * NEVER infers missing semantic intent.
 * If required fields are absent after mechanical repair, fails closed.
 */

export interface RepairResult {
  /** Whether any repair was applied. */
  repaired: boolean
  /** The potentially-repaired args (original if no repair applied). */
  args: Record<string, unknown>
  /** Description of what was repaired, if anything. */
  repairs: string[]
}

/** Known argument alias maps: wrong_key -> canonical_key */
const ALIAS_MAP: Record<string, Record<string, string>> = {
  // Common path aliases
  "*": {
    "path": "file_path",
    "filename": "file_path",
    "filepath": "file_path",
    "file": "file_path",
    "cmd": "command",
    "shell": "command",
    "subagent": "subagent_type",
    "agent": "subagent_type",
    "query": "pattern",
    "search_query": "pattern",
  },
  // fdx-read specific
  "fdx-read": {
    "file": "file_path",
    "path": "file_path",
  },
  // bash/shell
  "bash": {
    "cmd": "command",
    "shell_command": "command",
  },
}

/** Fields that should always be arrays, never scalars. */
const ARRAY_FIELDS = new Set([
  "files",
  "paths",
  "patterns",
  "items",
  "agents",
  "acceptance_criteria",
])

/** Normalize Windows path separators to POSIX for known path fields. */
const PATH_FIELDS = new Set(["file_path", "path", "filepath", "directory", "dir", "cwd"])

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  // Convert backslashes (both single and double) to forward slashes
  // eslint-disable-next-line no-useless-escape
  return value.replace(/\\/g, "/")
}

/**
 * Attempt deterministic mechanical repair on a tool call.
 *
 * @param tool  The tool name being called.
 * @param args  The raw arguments provided by the model.
 * @returns     RepairResult with repaired args and a list of what changed.
 */
export function repairToolCall(
  tool: string,
  args: Record<string, unknown>,
): RepairResult {
  const repaired = { ...args }
  const repairs: string[] = []

  // 1. Apply alias normalization
  const globalAliases = ALIAS_MAP["*"] ?? {}
  const toolAliases = ALIAS_MAP[tool] ?? {}
  const aliases = { ...globalAliases, ...toolAliases }

  for (const [wrong, canonical] of Object.entries(aliases)) {
    if (wrong in repaired && !(canonical in repaired)) {
      repaired[canonical] = repaired[wrong]
      delete repaired[wrong]
      repairs.push("alias: " + wrong + " -> " + canonical)
    }
  }

  // 2. Normalize scalar arrays
  for (const field of ARRAY_FIELDS) {
    if (field in repaired && !Array.isArray(repaired[field])) {
      repaired[field] = [repaired[field]]
      repairs.push("scalar->array: " + field)
    }
  }

  // 3. Normalize path separators on known path fields
  for (const field of PATH_FIELDS) {
    if (field in repaired) {
      const normalized = normalizePath(repaired[field])
      if (normalized != null && normalized !== repaired[field]) {
        repaired[field] = normalized
        repairs.push("path-separator: " + field)
      }
    }
  }

  return {
    repaired: repairs.length > 0,
    args: repaired,
    repairs,
  }
}

/**
 * Check whether a required field is present after repair.
 * Returns null if OK, or an error string if a required field is missing.
 */
export function validateRequiredFields(
  tool: string,
  args: Record<string, unknown>,
  requiredFields: string[],
): string | null {
  const missing = requiredFields.filter(f => !(f in args) || args[f] == null)
  if (missing.length === 0) return null
  return "TOOL_MISSING_REQUIRED_FIELDS:" + tool + ":" + missing.join(",")
}
