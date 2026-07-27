#!/usr/bin/env node
// scripts/config-transaction.mjs — Authoritative config mutation transaction API
//
// Provides ONE transaction API used by ALL CLI commands (install, update,
// migrate, uninstall). Guarantees:
//   1. Exact prior state captured before any mutation (config + manifest bytes)
//   2. Backup created before any mutation (abort if backup fails)
//   3. Provisional manifest written atomically before config edit
//   4. Config edit applied atomically (rollback on failure)
//   5. Manifest finalized atomically (remove provisional flag, record backup)
//   6. Byte-perfect rollback on any step failure (logged restoration errors)
//
// Exports: executeTransaction
//
// Used by: bin/flowdeck.js

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { safeParseConfig, applyJsoncEdits, createBackup, atomicWrite } from "./config-mutator.mjs";

/**
 * Execute a config mutation transaction.
 *
 * Implements a transactional flow:
 *   1a. Read and validate config
 *   1b. Capture exact prior state of config AND manifest (bytes + existence)
 *   2.  Create backup (MUST succeed or abort)
 *   3.  Parse existing manifest for semantic merge
 *   4.  Write provisional manifest atomically (fail if can't)
 *   5.  Apply edits atomically (byte-perfect rollback on failure)
 *   6.  Finalize manifest atomically (byte-perfect rollback on failure)
 *
 * @param {object} options
 * @param {string} options.configPath - Path to opencode.json
 * @param {Array<{ path: string[], value: any }>} options.edits - Edits to apply
 * @param {object} options.manifest - Manifest data to write (semantic fields only)
 * @param {string} options.manifestPath - Path for manifest file
 * @returns {{ ok: boolean, backupPath?: string, error?: string }}
 */
export async function executeTransaction({ configPath, edits, manifest, manifestPath }) {
  // ── Step 1a: Read and validate config ──────────────────────────────────
  const configExisted = existsSync(configPath);
  let rawContent = null;
  if (configExisted) {
    rawContent = readFileSync(configPath, "utf-8");
    const parsed = safeParseConfig(rawContent);
    if (!parsed.ok) {
      return { ok: false, error: "Malformed configuration: " + parsed.error };
    }
  }

  // ── Step 1b: Capture exact prior manifest state (bytes + existence) ────
  const manifestExisted = existsSync(manifestPath);
  let manifestRawContent = null;
  if (manifestExisted) {
    manifestRawContent = readFileSync(manifestPath, "utf-8");
  }

  // ── Step 2: Create backup (MUST succeed or abort) ─────────────────────
  const backupPath = configExisted ? createBackup(configPath) : null;
  if (!backupPath && configExisted) {
    return { ok: false, error: "Backup failed — no mutation performed" };
  }

  // ── Step 3: Parse existing manifest for semantic merge ────────────────
  let existingManifest = {};
  if (manifestExisted && manifestRawContent !== null) {
    try {
      existingManifest = JSON.parse(manifestRawContent);
    } catch {
      // Corrupt manifest — merge into empty object
    }
  }

  // ── Step 4: Write provisional manifest atomically ─────────────────────
  const provManifest = { ...existingManifest, ...manifest, _provisional: true, _backupPath: backupPath };
  try {
    atomicWrite(manifestPath, JSON.stringify(provManifest, null, 2) + "\n");
  } catch (err) {
    return { ok: false, error: "Failed to write provisional manifest: " + err.message };
  }

  // ── Step 5: Apply edits atomically (rollback on failure) ──────────────
  try {
    const updatedContent = applyJsoncEdits(rawContent || "{}", edits);
    atomicWrite(configPath, updatedContent);
  } catch (err) {
    // Byte-perfect rollback: restore exact prior state for both files
    const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);

    const suffix = restorationErrors.length > 0
      ? " (with restoration issues: " + restorationErrors.join("; ") + ")"
      : "";
    return { ok: false, error: "Config write failed — restored backup" + suffix + ": " + err.message };
  }

  // ── Step 6: Finalize manifest atomically ──────────────────────────────
  try {
    const finalManifest = {
      ...provManifest,
      _provisional: undefined,
      _backupPath: undefined,
      backupPath,
      installedAt: new Date().toISOString(),
    };
    atomicWrite(manifestPath, JSON.stringify(finalManifest, null, 2) + "\n");
  } catch (err) {
    // Byte-perfect rollback: restore exact prior state for both files
    const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);

    const suffix = restorationErrors.length > 0
      ? " (with restoration issues: " + restorationErrors.join("; ") + ")"
      : "";
    return { ok: false, error: "Manifest finalization failed — full rollback" + suffix + ": " + err.message };
  }

  return { ok: true, backupPath };
}

/**
 * Restore config and manifest files to their exact pre-transaction state.
 *
 * - If a file existed before the transaction: restore its exact byte content
 *   using an atomic write.
 * - If a file did NOT exist before the transaction: delete it (clean up
 *   what the transaction created).
 *
 * @param {string} configPath
 * @param {boolean} configExisted
 * @param {string|null} rawContent - Prior config content (null if nonexistent)
 * @param {string} manifestPath
 * @param {boolean} manifestExisted
 * @param {string|null} manifestRawContent - Prior manifest content (null if nonexistent)
 * @returns {string[]} Array of error messages (empty on full success)
 */
function restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent) {
  const errors = [];

  // Restore config
  if (configExisted && rawContent !== null) {
    try {
      atomicWrite(configPath, rawContent);
    } catch (rbErr) {
      errors.push("config restoration failed: " + rbErr.message);
    }
  } else {
    // Config did not exist before — delete what we created
    try {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    } catch (rbErr) {
      errors.push("config cleanup failed: " + rbErr.message);
    }
  }

  // Restore manifest
  if (manifestExisted && manifestRawContent !== null) {
    try {
      atomicWrite(manifestPath, manifestRawContent);
    } catch (rbErr) {
      errors.push("manifest restoration failed: " + rbErr.message);
    }
  } else {
    // Manifest did not exist before — delete what we created
    try {
      if (existsSync(manifestPath)) {
        unlinkSync(manifestPath);
      }
    } catch (rbErr) {
      errors.push("manifest cleanup failed: " + rbErr.message);
    }
  }

  return errors;
}
