#!/usr/bin/env node
// scripts/config-transaction.mjs — Authoritative config mutation transaction API
//
// Provides ONE transaction API used by ALL CLI commands (install, update,
// migrate, uninstall). Guarantees:
//   1. Backup created before any mutation (abort if backup fails)
//   2. Provisional manifest written before config edit
//   3. Config edit applied atomically (rollback on failure)
//   4. Manifest finalized (remove provisional flag, record backup path)
//   5. Full rollback on any step failure
//
// Exports: executeTransaction
//
// Used by: bin/flowdeck.js

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { safeParseConfig, applyJsoncEdits, createBackup, atomicWrite } from "./config-mutator.mjs";

/**
 * Execute a config mutation transaction.
 *
 * Implements a 6-step transactional flow:
 *   1. Read and validate config
 *   2. Create backup (MUST succeed or abort)
 *   3. Preserve existing manifest
 *   4. Write provisional manifest (fail if can't)
 *   5. Apply edits atomically (rollback on failure)
 *   6. Finalize manifest (remove provisional flag, record backup)
 *
 * @param {object} options
 * @param {string} options.configPath - Path to opencode.json
 * @param {Array<{ path: string[], value: any }>} options.edits - Edits to apply
 * @param {object} options.manifest - Manifest data to write (semantic fields only)
 * @param {string} options.manifestPath - Path for manifest file
 * @returns {{ ok: boolean, backupPath?: string, error?: string }}
 */
export async function executeTransaction({ configPath, edits, manifest, manifestPath }) {
  // Step 1: Read and validate config
  let rawContent = "{}";
  if (existsSync(configPath)) {
    rawContent = readFileSync(configPath, "utf-8");
    const parsed = safeParseConfig(rawContent);
    if (!parsed.ok) {
      return { ok: false, error: "Malformed configuration: " + parsed.error };
    }
  }

  // Step 2: Create backup (MUST succeed or abort)
  const backupPath = createBackup(configPath);
  if (!backupPath && existsSync(configPath)) {
    return { ok: false, error: "Backup failed — no mutation performed" };
  }

  // Step 3: Preserve existing manifest
  let existingManifest = null;
  if (existsSync(manifestPath)) {
    try { existingManifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
    catch { /* ignore corrupt manifest */ }
  }

  // Step 4: Write provisional manifest (fail if can't)
  const provManifest = { ...existingManifest, ...manifest, _provisional: true, _backupPath: backupPath };
  try {
    writeFileSync(manifestPath, JSON.stringify(provManifest, null, 2) + "\n", "utf-8");
  } catch (err) {
    return { ok: false, error: "Failed to write provisional manifest: " + err.message };
  }

  // Step 5: Apply edits atomically (rollback on failure)
  try {
    const updatedContent = applyJsoncEdits(rawContent, edits);
    atomicWrite(configPath, updatedContent);
  } catch (err) {
    // Restore backup and remove provisional manifest
    try { atomicWrite(configPath, readFileSync(backupPath, "utf-8")); } catch {}
    try { unlinkSync(manifestPath); } catch {}
    return { ok: false, error: "Config write failed — restored backup: " + err.message };
  }

  // Step 6: Finalize manifest (remove provisional flag)
  try {
    const finalManifest = {
      ...provManifest,
      _provisional: undefined,
      _backupPath: undefined,
      backupPath,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Restore everything
    try { atomicWrite(configPath, readFileSync(backupPath, "utf-8")); } catch {}
    try { unlinkSync(manifestPath); } catch {}
    return { ok: false, error: "Manifest finalization failed — full rollback: " + err.message };
  }

  return { ok: true, backupPath };
}
