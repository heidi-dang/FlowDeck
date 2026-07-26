#!/usr/bin/env node
// scripts/config-mutator.mjs — Shared JSONC-safe configuration editor
//
// Standalone ESM module providing JSONC-preserving config editing with:
// - Targeted edits via jsonc-parser modify/applyEdits (preserves comments,
//   formatting, and trailing commas)
// - Atomic writes via temp file + rename
// - Timestamped backups with automatic retention enforcement (max 5)
// - Parse validation that rejects edits on malformed content
// - No silent data loss, no empty catch blocks
//
// Used by: bin/flowdeck.js, postinstall.mjs, install.sh, uninstall.sh

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { modify, applyEdits, parse } from "jsonc-parser";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of backup files to retain per config file. */
export const retentionLimit = 5;

/** Default formatting options passed to jsonc-parser modify. */
const FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

/** Glob-safe marker prefix for temp files created during atomic writes. */
const TMP_PREFIX = ".tmp.";

// ── Parse & Read ─────────────────────────────────────────────────────────────

/**
 * Parse JSONC content safely using jsonc-parser.
 *
 * Returns a structured result rather than throwing — allows callers to
 * distinguish between "file not found", "malformed content", and "valid".
 *
 * @param {string} content - Raw JSONC text
 * @returns {{ ok: boolean, data: any, error?: string }}
 */
export function safeParseConfig(content) {
  if (typeof content !== "string") {
    return { ok: false, data: undefined, error: "Content must be a string" };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, data: undefined, error: "Content is empty (whitespace only)" };
  }

  try {
    const errors = [];
    const data = parse(content, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
      const detail = errors
        .map((e) => {
          const code = typeof e.error === "number" ? e.error : 0;
          return `ParseErrorCode ${code} at offset ${e.offset ?? 0}`;
        })
        .join("; ");
      return { ok: false, data: undefined, error: `Parse error(s): ${detail}` };
    }

    // parse returns undefined when content is empty or contains only trivia
    if (data === undefined) {
      return { ok: false, data: undefined, error: "Content parsed to undefined — expected an object or array" };
    }

    return { ok: true, data, error: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, data: undefined, error: `Unexpected parse error: ${message}` };
  }
}

/**
 * Read a JSONC file from disk and parse it.
 *
 * Returns structured result (never throws).  The raw content is included so
 * callers can pass it directly to {@link writeConfig} or {@link applyJsoncEdits}.
 *
 * @param {string} filePath - Absolute path to the JSONC file
 * @returns {{ ok: boolean, data?: any, rawContent?: string, error?: string }}
 */
export function readConfig(filePath) {
  if (!existsSync(filePath)) {
    return { ok: false, data: undefined, rawContent: undefined, error: `File not found: ${filePath}` };
  }

  let rawContent;
  try {
    rawContent = readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, data: undefined, rawContent: undefined, error: `Failed to read file: ${message}` };
  }

  const parsed = safeParseConfig(rawContent);
  if (!parsed.ok) {
    return { ok: false, data: undefined, rawContent, error: parsed.error };
  }

  return { ok: true, data: parsed.data, rawContent, error: undefined };
}

// ── Edits ────────────────────────────────────────────────────────────────────

/**
 * Apply an array of JSONC edits to raw content, preserving comments, formatting,
 * and trailing commas.
 *
 * Each edit must be:
 *   `{ path: string[], value: any }`
 *
 * Edits are applied sequentially via jsonc-parser's `modify` + `applyEdits`.
 *
 * @param {string} rawContent - Original JSONC text
 * @param {Array<{ path: string[], value: any }>} edits - Edits to apply
 * @returns {string} Updated JSONC text
 * @throws {Error} If rawContent is not a string, edits is not an array, or any
 *   edit is malformed
 */
export function applyJsoncEdits(rawContent, edits) {
  if (typeof rawContent !== "string") {
    throw new Error("applyJsoncEdits: rawContent must be a string");
  }

  if (!Array.isArray(edits)) {
    throw new Error("applyJsoncEdits: edits must be an array");
  }

  let content = rawContent;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    if (!edit || typeof edit !== "object") {
      throw new Error(`applyJsoncEdits: edit at index ${i} is not an object`);
    }

    if (!Array.isArray(edit.path)) {
      throw new Error(`applyJsoncEdits: edit at index ${i} has no 'path' array`);
    }

    if (edit.path.length === 0) {
      throw new Error(`applyJsoncEdits: edit at index ${i} has an empty path`);
    }

    content = applyEdits(
      content,
      modify(content, edit.path, edit.value, {
        formattingOptions: FORMATTING_OPTIONS,
      }),
    );
  }

  return content;
}

// ── Backup & Retention ───────────────────────────────────────────────────────

/**
 * Create a timestamped backup copy of the file at `filePath`.
 *
 * After creating the backup, enforces retention: if the number of backup files
 * (matching `<basename>.bak.<timestamp>`) exceeds {@link retentionLimit},
 * the oldest backups are pruned.
 *
 * @param {string} filePath - Path to the file to back up
 * @returns {string | null} Backup file path, or null if the source file does not exist
 * @throws {Error} If the backup copy operation itself fails
 */
export function createBackup(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = Date.now();
  const backupPath = join(dir, `${base}.bak.${timestamp}`);

  // Create the backup copy
  try {
    copyFileSync(filePath, backupPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create backup at ${backupPath}: ${message}`);
  }

  // Prune oldest backups beyond retention limit (best-effort)
  enforceRetention(filePath);

  return backupPath;
}

/**
 * Remove oldest backup files exceeding retentionLimit.
 *
 * Scans `dir` for files matching `<basename>.bak.<integer>`, sorts by
 * timestamp, and deletes the oldest if count > retentionLimit.
 *
 * This is a best-effort cleanup — directory read or unlink failures are
 * silently skipped so they never block the calling workflow.
 */
function enforceRetention(filePath) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const prefix = `${base}.bak.`;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Cannot read directory — skip retention enforcement
    return;
  }

  const backupFiles = entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({
      name,
      path: join(dir, name),
      timestamp: Number(name.slice(prefix.length)),
    }))
    .filter((b) => !isNaN(b.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp); // oldest first

  if (backupFiles.length <= retentionLimit) {
    return;
  }

  const toDelete = backupFiles.slice(0, backupFiles.length - retentionLimit);
  for (const file of toDelete) {
    try {
      unlinkSync(file.path);
    } catch {
      // Best-effort per-file cleanup — skip if we can't remove
    }
  }
}

// ── Atomic Write ─────────────────────────────────────────────────────────────

/**
 * Write content to `filePath` atomically using a temp file + rename strategy.
 *
 * 1. Writes content to a uniquely-named temp file in the same directory
 * 2. Renames (atomically on most filesystems) the temp file over the target
 * 3. Cleans up the temp file on any failure
 *
 * @param {string} filePath - Destination file path
 * @param {string} content - Content to write
 * @returns {true} Always returns true on success
 * @throws {Error} On write or rename failure (temp file cleaned up first)
 */
export function atomicWrite(filePath, content) {
  if (typeof content !== "string") {
    throw new Error("atomicWrite: content must be a string");
  }

  const dir = dirname(filePath);
  const base = basename(filePath);

  // Ensure the target directory exists
  mkdirSync(dir, { recursive: true });

  // Unique temp file in the same directory (same filesystem → rename is atomic)
  const tmpFile = join(dir, `${TMP_PREFIX}${base}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync(tmpFile, filePath);
    return true;
  } catch (err) {
    // Clean up temp file before re-throwing to avoid orphaned files
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch {
      // Best-effort temp cleanup — original error takes precedence
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ── Combined Workflow ────────────────────────────────────────────────────────

/**
 * Read, validate, back up, apply edits, and write atomically — the primary
 * workflow for safe JSONC configuration mutation.
 *
 * Guarantees:
 * 1. Content is valid and parseable before any mutation (rejects malformed)
 * 2. Backup is created and confirmed on disk *before* the write proceeds
 * 3. Edits preserve JSONC comments, formatting, and trailing commas
 * 4. Write is atomic (temp file + rename)
 *
 * @param {string} filePath - Path to the JSONC file
 * @param {string} rawContent - Current raw text content of the file
 * @param {Array<{ path: string[], value: any }>} edits - Edits to apply
 * @returns {{ ok: boolean, backupPath?: string | null, error?: string }}
 */
export function writeConfig(filePath, rawContent, edits) {
  // No edits → no work
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: true, backupPath: null, error: undefined };
  }

  // Step 1: Validate content — never mutate malformed data
  const parseResult = safeParseConfig(rawContent);
  if (!parseResult.ok) {
    return {
      ok: false,
      backupPath: undefined,
      error: `Malformed content — edits rejected: ${parseResult.error}`,
    };
  }

  // Step 2: Backup before mutation (only if file already exists)
  let backupPath = null;
  if (existsSync(filePath)) {
    try {
      backupPath = createBackup(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        backupPath: undefined,
        error: `Backup failed — no mutation performed: ${message}`,
      };
    }

    // Confirm the backup file actually exists on disk
    if (!backupPath || !existsSync(backupPath)) {
      return {
        ok: false,
        backupPath: undefined,
        error: "Backup failed — backup file does not exist after creation attempt",
      };
    }
  }

  // Step 3: Apply edits
  let updatedContent;
  try {
    updatedContent = applyJsoncEdits(rawContent, edits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, backupPath, error: `Failed to apply edits: ${message}` };
  }

  // Step 4: Atomic write
  try {
    atomicWrite(filePath, updatedContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, backupPath, error: `Atomic write failed: ${message}` };
  }

  return { ok: true, backupPath, error: undefined };
}
