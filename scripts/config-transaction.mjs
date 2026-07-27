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

export const fsAdapter = {
  readFileSync,
  existsSync,
  unlinkSync,
  createBackup,
  atomicWrite,
};

/**
 * Execute a config mutation transaction.
 *
 * Implements a transactional flow:
 *   1a. Read and validate config
 *   1b. Capture exact prior state of config AND manifest (bytes + existence)
 *   2.  Create backup (MUST succeed or abort)
 *   3.  Parse existing manifest for semantic merge (fail closed on corrupt manifest unless allowCorruptManifest: true)
 *   4.  Write provisional manifest atomically (unless skipManifest: true)
 *   5.  Apply edits atomically (byte-perfect rollback on failure)
 *   6.  Finalize or delete manifest atomically (byte-perfect rollback on failure)
 *
 * @param {object} options
 * @param {string} options.configPath - Path to opencode.json
 * @param {Array<{ path: string[], value: any }>} options.edits - Edits to apply
 * @param {object} [options.manifest] - Manifest data to write (semantic fields only)
 * @param {string} options.manifestPath - Path for manifest file
 * @param {boolean} [options.allowCorruptManifest=false] - If true, ignore corrupt manifest errors
 * @param {boolean} [options.skipManifest=false] - If true, do not create or modify manifest
 * @param {boolean} [options.deleteManifest=false] - If true, delete manifest file as part of transaction
 * @returns {Promise<{ ok: boolean, backupPath?: string, error?: string }>}
 */
export async function executeTransaction({
  configPath,
  edits,
  manifest,
  manifestPath,
  allowCorruptManifest = false,
  skipManifest = false,
  deleteManifest = false,
}) {
  // ── Step 1a: Read and validate config ──────────────────────────────────
  const configExisted = fsAdapter.existsSync(configPath);
  let rawContent = null;
  if (configExisted) {
    try {
      rawContent = fsAdapter.readFileSync(configPath, "utf-8");
    } catch (readErr) {
      return { ok: false, error: "Failed to read configuration file: " + readErr.message };
    }
    const parsed = safeParseConfig(rawContent);
    if (!parsed.ok) {
      return { ok: false, error: "Malformed configuration: " + parsed.error };
    }
  }

  // ── Step 1b: Capture exact prior manifest state (bytes + existence) ────
  const manifestExisted = fsAdapter.existsSync(manifestPath);
  let manifestRawContent = null;
  if (manifestExisted) {
    try {
      manifestRawContent = fsAdapter.readFileSync(manifestPath, "utf-8");
    } catch (readErr) {
      if (!allowCorruptManifest) {
        return { ok: false, error: "Failed to read install manifest: " + readErr.message };
      }
    }
  }

  // ── Step 2: Create backup (MUST succeed or abort) ─────────────────────
  const backupPath = configExisted ? fsAdapter.createBackup(configPath) : null;
  if (!backupPath && configExisted) {
    return { ok: false, error: "Backup failed — no mutation performed" };
  }

  // ── Step 3: Parse existing manifest for semantic merge ────────────────
  let existingManifest = {};
  if (manifestExisted && manifestRawContent !== null) {
    try {
      existingManifest = JSON.parse(manifestRawContent);
    } catch {
      if (!allowCorruptManifest) {
        return { ok: false, error: "Corrupt install manifest: " + manifestPath };
      }
    }
  }

  // ── Step 4: Write provisional manifest atomically ─────────────────────
  let provManifest = null;
  if (!skipManifest && !deleteManifest && manifest) {
    provManifest = { ...existingManifest, ...manifest, _provisional: true, _backupPath: backupPath };
    try {
      fsAdapter.atomicWrite(manifestPath, JSON.stringify(provManifest, null, 2) + "\n");
    } catch (err) {
      return { ok: false, error: "Failed to write provisional manifest: " + err.message };
    }
  }

  // ── Step 5: Apply edits atomically (rollback on failure) ──────────────
  try {
    if (process.env.FLOWDECK_FAIL_AT_STAGE === "config_write") {
      throw new Error("Injected env config write failure");
    }
    const updatedContent = applyJsoncEdits(rawContent || "{}", edits);
    fsAdapter.atomicWrite(configPath, updatedContent);
  } catch (err) {
    // Byte-perfect rollback: restore exact prior state for both files
    const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);

    const suffix = restorationErrors.length > 0
      ? " (with restoration issues: " + restorationErrors.join("; ") + ")"
      : "";
    return { ok: false, error: "Config write failed — restored backup" + suffix + ": " + err.message };
  }

  // ── Step 6: Finalize or delete manifest atomically ──────────────────────
  if (deleteManifest) {
    try {
      if (fsAdapter.existsSync(manifestPath)) {
        fsAdapter.unlinkSync(manifestPath);
      }
    } catch (err) {
      const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);
      const suffix = restorationErrors.length > 0 ? " (restoration issues: " + restorationErrors.join("; ") + ")" : "";
      return { ok: false, error: "Manifest deletion failed — full rollback" + suffix + ": " + err.message };
    }
  } else if (!skipManifest && provManifest) {
    try {
      if (process.env.FLOWDECK_FAIL_AT_STAGE === "manifest_finalize") {
        throw new Error("Injected env manifest finalization failure");
      }
      const finalManifest = {
        ...provManifest,
        _provisional: undefined,
        _backupPath: undefined,
        backupPath,
        installedAt: new Date().toISOString(),
      };
      fsAdapter.atomicWrite(manifestPath, JSON.stringify(finalManifest, null, 2) + "\n");
    } catch (err) {
      // Byte-perfect rollback: restore exact prior state for both files
      const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);

      const suffix = restorationErrors.length > 0
        ? " (with restoration issues: " + restorationErrors.join("; ") + ")"
        : "";
      return { ok: false, error: "Manifest finalization failed — full rollback" + suffix + ": " + err.message };
    }
  }

  return { ok: true, backupPath };
}

/**
 * Execute an atomic, rollback-capable configuration rollback.
 *
 * Restores configPath to backupPath content and updates manifestPath state.
 * On failure, restores exact pre-rollback byte states for both files.
 *
 * @param {object} options
 * @param {string} options.configPath
 * @param {string} options.manifestPath
 * @param {string} options.backupPath
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function executeRollbackTransaction({ configPath, manifestPath, backupPath }) {
  const configExisted = fsAdapter.existsSync(configPath);
  let rawContent = null;
  if (configExisted) {
    try {
      rawContent = fsAdapter.readFileSync(configPath, "utf-8");
    } catch (err) {
      return { ok: false, error: "Failed to read existing config before rollback: " + err.message };
    }
  }

  const manifestExisted = fsAdapter.existsSync(manifestPath);
  let manifestRawContent = null;
  if (manifestExisted) {
    try {
      manifestRawContent = fsAdapter.readFileSync(manifestPath, "utf-8");
    } catch { /* ignore */ }
  }

  if (!fsAdapter.existsSync(backupPath)) {
    return { ok: false, error: "Backup file does not exist: " + backupPath };
  }

  let backupContent = null;
  try {
    backupContent = fsAdapter.readFileSync(backupPath, "utf-8");
  } catch (err) {
    return { ok: false, error: "Failed to read backup file: " + err.message };
  }

  // Create pre-rollback backup of current config state
  if (configExisted) {
    const preRollbackBackup = fsAdapter.createBackup(configPath);
    if (!preRollbackBackup) {
      return { ok: false, error: "Failed to create pre-rollback backup" };
    }
  }

  // Apply backup content atomically to configPath
  try {
    fsAdapter.atomicWrite(configPath, backupContent);
  } catch (err) {
    const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);
    const suffix = restorationErrors.length > 0 ? " (restoration issues: " + restorationErrors.join("; ") + ")" : "";
    return { ok: false, error: "Rollback config write failed" + suffix + ": " + err.message };
  }

  // Update manifest to record rollback timestamp if manifest exists
  if (manifestExisted && manifestRawContent) {
    try {
      const parsed = JSON.parse(manifestRawContent);
      parsed.rolledBackAt = new Date().toISOString();
      parsed.rolledBackFromBackup = backupPath;
      fsAdapter.atomicWrite(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
    } catch (err) {
      // If manifest update fails, restore prior state
      const restorationErrors = restorePriorState(configPath, configExisted, rawContent, manifestPath, manifestExisted, manifestRawContent);
      const suffix = restorationErrors.length > 0 ? " (restoration issues: " + restorationErrors.join("; ") + ")" : "";
      return { ok: false, error: "Rollback manifest update failed" + suffix + ": " + err.message };
    }
  }

  return { ok: true };
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
      fsAdapter.atomicWrite(configPath, rawContent);
    } catch (rbErr) {
      errors.push("config restoration failed: " + rbErr.message);
    }
  } else {
    // Config did not exist before — delete what we created
    try {
      if (fsAdapter.existsSync(configPath)) {
        fsAdapter.unlinkSync(configPath);
      }
    } catch (rbErr) {
      errors.push("config cleanup failed: " + rbErr.message);
    }
  }

  // Restore manifest
  if (manifestExisted && manifestRawContent !== null) {
    try {
      fsAdapter.atomicWrite(manifestPath, manifestRawContent);
    } catch (rbErr) {
      errors.push("manifest restoration failed: " + rbErr.message);
    }
  } else {
    // Manifest did not exist before — delete what we created
    try {
      if (fsAdapter.existsSync(manifestPath)) {
        fsAdapter.unlinkSync(manifestPath);
      }
    } catch (rbErr) {
      errors.push("manifest cleanup failed: " + rbErr.message);
    }
  }

  return errors;
}
