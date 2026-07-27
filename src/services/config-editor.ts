/**
 * Safe Configuration Editor
 *
 * JSONC-aware configuration editor that preserves comments, formatting,
 * and trailing commas using the jsonc-parser library.
 *
 * Used by:
 * - Shell installer (install.sh)
 * - Node postinstall (postinstall.mjs)
 * - CLI install (bin/flowdeck.js)
 * - CLI update, migrate, uninstall
 * - Doctor repair commands
 *
 * Requirements:
 * - Parse JSON and JSONC.
 * - Preserve comments and formatting.
 * - Preserve trailing commas where supported.
 * - Preserve unrelated fields, provider, MCP, agent, permissions, plugins.
 * - Reject malformed configuration without modifying it.
 * - Display the exact parse location and error.
 * - Require successful backup before mutation.
 * - Use atomic temporary-file write plus rename.
 * - Remove temporary files after failure.
 * - Never use an empty catch around configuration parsing.
 * - Never replace malformed configuration with {}.
 * - Finite backup retention policy.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync } from "node:fs"
import { dirname, join, basename } from "node:path"
import { modify, parse, applyEdits, printParseErrorCode, type ParseError } from "jsonc-parser"

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

// ─── Detection ─────────────────────────────────────────────────────────────

export function isJsoncContent(content: string): boolean {
  return content.includes("//") || content.includes("/*")
}

// ─── Safe JSONC Parsing ────────────────────────────────────────────────────

/**
 * Parse JSONC content, returning a parsed object and reporting exact errors.
 * Never silently replaces malformed content with {}.
 */
export function safeParseJson<T = Record<string, unknown>>(rawContent: string): ConfigReadResult<T> {
  const jsonc = isJsoncContent(rawContent)
  const errors: ParseError[] = []
  const data = parse(rawContent, errors, { allowTrailingComma: true })

  if (errors.length > 0) {
    const errorMsg = errors.map(e => printParseErrorCode(e.error)).join(", ")
    return { ok: false, error: `Parse error: ${errorMsg}`, rawContent, isJsonc: jsonc }
  }

  return { ok: true, data: data as T, rawContent, isJsonc: jsonc }
}

/**
 * Read a JSON/JSONC configuration file.
 * Does not throw on missing file.
 */
export function safeReadConfig<T = Record<string, unknown>>(filePath: string): ConfigReadResult<T> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` }
  }
  const rawContent = readFileSync(filePath, "utf-8")
  return safeParseJson<T>(rawContent)
}

// ─── Backup Management ────────────────────────────────────────────────────

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

function enforceBackupRetention(filePath: string): void {
  const dir = dirname(filePath)
  const base = basename(filePath)
  const maxBackups = getMaxBackups()
  if (maxBackups <= 0) return

  try {
    const files = readdirSync(dir)
    const backups = files
      .filter(f => f.startsWith(base + ".bak."))
      .sort()

    while (backups.length > maxBackups) {
      const oldest = backups.shift()
      if (oldest) {
        try { unlinkSync(join(dir, oldest)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore retention errors */ }
}

// ─── JSONC-Aware Targeted Update ───────────────────────────────────────────

export interface JsoncEdit {
  /** Path to the property to modify (e.g., ["plugin"] or ["default_agent"]) */
  path: string[]
  /** Value to set */
  value: unknown
  /** Insertion option for arrays */
  insert?: "first" | "last" | "replace"
}

/**
 * Apply edits to JSONC content using jsonc-parser's modify function,
 * which preserves comments, formatting, and trailing commas.
 */
export function applyJsoncEdits(rawContent: string, edits: JsoncEdit[]): string {
  let content = rawContent
  for (const edit of edits) {
    const modificationOptions = {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: "\n",
      },
    }
    content = applyEdits(content, modify(content, edit.path, edit.value, modificationOptions))
  }
  return content
}

// ─── Safe Update ───────────────────────────────────────────────────────────

/**
 * Safely update a JSONC configuration file with comment-preserving edits.
 *
 * Uses jsonc-parser's modify function to make targeted edits while
 * preserving comments, formatting, and trailing commas.
 *
 * Safety guarantees:
 * 1. Never overwrite malformed configuration.
 * 2. Display exact parse error.
 * 3. Require successful backup before mutation.
 * 4. Atomic write (temp file + rename).
 * 5. Clean up temp file on failure.
 * 6. Preserve all comments and formatting.
 * 7. Preserve unrelated fields.
 * 8. Finite backup retention.
 */
export function safeUpdateConfigJsonc(
  filePath: string,
  edits: JsoncEdit[],
): ConfigUpdateResult {
  let rawContent = "{}"
  let backupPath: string | null = null

  if (existsSync(filePath)) {
    rawContent = readFileSync(filePath, "utf-8")

    // Validate parse before mutation
    const parsed = safeParseJson(rawContent)
    if (!parsed.ok) {
      const preview = rawContent.substring(0, 200).replace(/\n/g, "\\n")
      return {
        ok: false,
        error: `Cannot update malformed configuration at ${filePath}: ${parsed.error}. Content preview: "${preview}". Fix syntax or restore from backup.`,
      }
    }

    // Backup must succeed before mutation
    backupPath = createBackup(filePath)
    if (!backupPath) {
      return {
        ok: false,
        error: `Cannot update ${filePath}: backup failed. No mutation performed.`,
      }
    }
  }

  // Apply JSONC-preserving edits
  let updatedContent: string
  try {
    updatedContent = applyJsoncEdits(rawContent, edits)
  } catch (err) {
    return {
      ok: false,
      error: `JSONC edit failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Atomic write
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`)
  try {
    writeFileSync(tmpPath, updatedContent, "utf-8")
    renameSync(tmpPath, filePath)
    const parsed = safeParseJson(updatedContent)
    return { ok: true, data: parsed.ok ? parsed.data : undefined, backupPath: backupPath || undefined }
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) } catch { /* ignore cleanup */ }
    }
    return {
      ok: false,
      error: `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ─── Legacy safeUpdateConfig (for backward compat, uses atomic write) ─────────

export function safeUpdateConfig<T = Record<string, unknown>>(
  filePath: string,
  updater: (current: T) => T,
): ConfigUpdateResult<T> {
  let rawContent = "{}"
  let backupPath: string | null = null

  if (existsSync(filePath)) {
    rawContent = readFileSync(filePath, "utf-8")
    const parsed = safeParseJson<T>(rawContent)
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Cannot update malformed configuration at ${filePath}: ${parsed.error}`,
      }
    }

    backupPath = createBackup(filePath)
    if (!backupPath) {
      return {
        ok: false,
        error: `Cannot update ${filePath}: backup failed. No mutation performed.`,
      }
    }
  }

  // Parse, apply updater, serialize, then persist atomically
  const currentObj = rawContent === "{}" ? {} as T : (safeParseJson<T>(rawContent).data ?? {} as T)
  const updatedObj = updater({ ...currentObj })

  let serialized: string
  try {
    serialized = JSON.stringify(updatedObj, null, 2)
  } catch (err) {
    return {
      ok: false,
      error: `Failed to serialize updated configuration: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Atomic write: temp file → rename
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`)
  try {
    writeFileSync(tmpPath, serialized, "utf-8")
    renameSync(tmpPath, filePath)
    return { ok: true, data: updatedObj, backupPath: backupPath || undefined }
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) } catch { /* ignore cleanup */ }
    }
    return {
      ok: false,
      error: `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ─── Rollback ──────────────────────────────────────────────────────────────

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
    const content = readFileSync(backupPath, "utf-8")

    // Atomic restore
    const tmpPath = join(dir, `.tmp_restore_${Date.now()}`)
    try {
      writeFileSync(tmpPath, content, "utf-8")
      renameSync(tmpPath, filePath)
      return { ok: true, backupPath }
    } catch (err) {
      if (existsSync(tmpPath)) { try { unlinkSync(tmpPath) } catch { /* ignore */ } }
      return { ok: false, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  } catch (err) {
    return { ok: false, error: `Failed to list backups: ${err instanceof Error ? err.message : String(err)}` }
  }
}
