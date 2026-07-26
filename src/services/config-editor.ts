/**
 * Safe Configuration Editor
 *
 * One shared configuration editor used by:
 * - Shell installer (install.sh)
 * - Node postinstall (postinstall.mjs)
 * - CLI install (bin/flowdeck.js)
 * - CLI update
 * - CLI uninstall
 * - Migration
 * - Doctor repair commands
 *
 * Requirements:
 * - Parse JSON and JSONC.
 * - Preserve comments and formatting where practical.
 * - Preserve unrelated fields.
 * - Preserve provider, MCP, agent, permission and plugin entries.
 * - Reject malformed configuration without modifying it.
 * - Display the exact parse location and error.
 * - Require a successful backup before mutation.
 * - Use atomic temporary-file write plus rename.
 * - Remove temporary files after failure.
 * - Never use an empty catch around configuration parsing.
 * - Never replace malformed configuration with {}.
 * - Avoid unbounded timestamped backup accumulation.
 * - Maintain a configurable finite backup retention policy.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync } from "node:fs"
import { dirname, join, basename } from "node:path"

// ─── Default retention ─────────────────────────────────────────────────────
const DEFAULT_MAX_BACKUPS = 5

export function getMaxBackups(): number {
  const env = process.env.FLOWDECK_MAX_BACKUPS
  if (env) {
    const n = Number.parseInt(env, 10)
    if (!Number.isNaN(n) && n >= 0) return n
  }
  return DEFAULT_MAX_BACKUPS
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ConfigReadResult<T = Record<string, unknown>> {
  ok: boolean
  data?: T
  error?: string
  rawContent?: string
  isJsonc?: boolean
}

export interface ConfigUpdateResult<T = Record<string, unknown>> {
  ok: boolean
  data?: T
  backupPath?: string
  error?: string
}

// ─── JSONC Comment Stripping ───────────────────────────────────────────────

/**
 * Strip single-line (//) and multi-line (/* ... *\/) comments from JSONC text safely,
 * preserving strings that contain comment delimiters.
 */
export function stripJsonComments(jsoncText: string): string {
  let insideString: string | false = false
  let insideComment: "single" | "multi" | false = false
  let result = ""

  for (let i = 0; i < jsoncText.length; i++) {
    const char = jsoncText[i]
    const nextChar = jsoncText[i + 1]

    if (insideComment === "single") {
      if (char === "\n" || char === "\r") {
        insideComment = false
        result += char
      }
      continue
    }

    if (insideComment === "multi") {
      if (char === "*" && nextChar === "/") {
        insideComment = false
        i++
      }
      continue
    }

    if (insideString) {
      result += char
      if (char === "\\" && i + 1 < jsoncText.length) {
        result += jsoncText[++i]
      } else if (char === insideString) {
        insideString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      insideString = char
      result += char
      continue
    }

    if (char === "/" && nextChar === "/") {
      insideComment = "single"
      i++
      continue
    }

    if (char === "/" && nextChar === "*") {
      insideComment = "multi"
      i++
      continue
    }

    result += char
  }

  return result
}

// ─── Detection ─────────────────────────────────────────────────────────────

/**
 * Detect if content is JSONC (has comments).
 */
export function isJsoncContent(content: string): boolean {
  return content.includes("//") || content.includes("/*")
}

// ─── Parsing ───────────────────────────────────────────────────────────────

/**
 * Safely parse JSON or JSONC content.
 * Returns exact error message if parsing fails.
 * Never replaces malformed content with {}.
 */
export function safeParseJson<T = Record<string, unknown>>(rawContent: string): ConfigReadResult<T> {
  const jsonc = isJsoncContent(rawContent)
  const stripped = stripJsonComments(rawContent)
  try {
    const data = JSON.parse(stripped) as T
    return { ok: true, data, rawContent, isJsonc: jsonc }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: errorMsg, rawContent, isJsonc: jsonc }
  }
}

/**
 * Read a JSON/JSONC configuration file.
 * Does not throw on missing file.
 * Never silently replaces malformed content.
 */
export function safeReadConfig<T = Record<string, unknown>>(filePath: string): ConfigReadResult<T> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` }
  }
  const rawContent = readFileSync(filePath, "utf-8")
  return safeParseJson<T>(rawContent)
}

// ─── Backup Management ────────────────────────────────────────────────────

/**
 * Create a timestamped backup of a configuration file.
 * Returns the backup path, or null on failure.
 */
export function createBackup(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const dir = dirname(filePath)
  const base = basename(filePath)
  const timestamp = Date.now()
  const backupPath = join(dir, `${base}.bak.${timestamp}`)
  try {
    copyFileSync(filePath, backupPath)
    enforceBackupRetention(filePath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * Enforce finite backup retention policy.
 * Removes oldest backups when count exceeds max.
 */
function enforceBackupRetention(filePath: string): void {
  const dir = dirname(filePath)
  const base = basename(filePath)
  const maxBackups = getMaxBackups()
  if (maxBackups <= 0) return // unlimited

  try {
    const files = readdirSync(dir)
    const backups = files
      .filter(f => f.startsWith(base + ".bak."))
      .map(f => ({ name: f, path: join(dir, f), mtime: existsSync(join(dir, f)) ? readFileSync(join(dir, f)).length : 0 }))
      // Sort by timestamp embedded in filename
      .sort((a, b) => a.name.localeCompare(b.name))

    while (backups.length > maxBackups) {
      const oldest = backups.shift()
      if (oldest) {
        try { unlinkSync(oldest.path) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore retention errors — non-critical */ }
}

// ─── Update ────────────────────────────────────────────────────────────────

/**
 * Safely update a JSON/JSONC configuration file.
 *
 * Safety guarantees:
 * 1. Never overwrite malformed configuration files.
 * 2. Display exact parse location and error for malformed config.
 * 3. Require successful backup before mutation.
 * 4. Atomic write using temporary file + rename.
 * 5. Remove temporary files after failure.
 * 6. Preserve unrelated keys and properties.
 * 7. Never replace malformed configuration with {}.
 * 8. No unbounded backup accumulation.
 */
export function safeUpdateConfig<T = Record<string, unknown>>(
  filePath: string,
  updater: (current: T) => T
): ConfigUpdateResult<T> {
  let currentObj: T = {} as T
  let backupPath: string | null = null

  if (existsSync(filePath)) {
    const readRes = safeReadConfig<T>(filePath)
    if (!readRes.ok) {
      // Show exact parse location and error
      const errorDetail = readRes.error || "Unknown parse error"
      const rawPreview = readRes.rawContent
        ? readRes.rawContent.substring(0, 200).replace(/\n/g, "\\n")
        : ""
      return {
        ok: false,
        error: `Cannot update malformed configuration at ${filePath}: ${errorDetail}. Raw content starts with: "${rawPreview}". Fix the syntax errors first, or restore from backup.`,
      }
    }
    currentObj = readRes.data!

    // Create backup before mutation — fail if backup fails
    backupPath = createBackup(filePath)
    if (!backupPath) {
      return {
        ok: false,
        error: `Cannot update configuration at ${filePath}: failed to create backup. No mutation performed.`,
      }
    }
  }

  // Apply mutations while preserving existing unrelated keys
  const updatedObj = updater({ ...currentObj })

  const dir = dirname(filePath)
  const tmpPath = join(dir, `.tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`)

  try {
    const formatted = JSON.stringify(updatedObj, null, 2) + "\n"
    writeFileSync(tmpPath, formatted, "utf-8")
    renameSync(tmpPath, filePath)
    return { ok: true, data: updatedObj, backupPath: backupPath || undefined }
  } catch (err) {
    // Clean up temporary file on failure
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    }
    return {
      ok: false,
      error: `Failed atomic write for configuration at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ─── Rollback ──────────────────────────────────────────────────────────────

/**
 * Rollback to the most recent backup.
 * Returns the restored data, or error if no backup exists.
 */
export function rollbackConfig<T = Record<string, unknown>>(filePath: string): ConfigUpdateResult<T> {
  const dir = dirname(filePath)
  const base = basename(filePath)

  try {
    const files = readdirSync(dir)
    const backups = files
      .filter(f => f.startsWith(base + ".bak."))
      .sort()
      .reverse()

    if (backups.length === 0) {
      return { ok: false, error: `No backups found for ${filePath}` }
    }

    const latestBackup = backups[0]
    const backupPath = join(dir, latestBackup)

    // Read backup data
    const backupContent = readFileSync(backupPath, "utf-8")
    const parseResult = safeParseJson<T>(backupContent)
    if (!parseResult.ok) {
      return { ok: false, error: `Backup file ${latestBackup} is corrupt: ${parseResult.error}` }
    }

    // Atomic restore
    const tmpPath = join(dir, `.tmp_restore_${Date.now()}`)
    try {
      writeFileSync(tmpPath, backupContent, "utf-8")
      renameSync(tmpPath, filePath)
      return { ok: true, data: parseResult.data, backupPath }
    } catch (err) {
      if (existsSync(tmpPath)) {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      }
      return { ok: false, error: `Failed to restore backup: ${err instanceof Error ? err.message : String(err)}` }
    }
  } catch (err) {
    return { ok: false, error: `Failed to list backups: ${err instanceof Error ? err.message : String(err)}` }
  }
}
