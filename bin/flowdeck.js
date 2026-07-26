#!/usr/bin/env node
// bin/flowdeck.js — FlowDeck CLI (Heidi fork)
// Full installer, verifier, doctor, config manager, and uninstaller
//
// Usage:
//   flowdeck install              Install plugin in opencode.json
//   flowdeck install --project    Install in project .opencode/
//   flowdeck install --local-repo Install from local checkout
//   flowdeck update               Update plugin registration
//   flowdeck verify               Verify fork identity and registration
//   flowdeck doctor               Run comprehensive diagnostics
//   flowdeck config validate      Validate JSON/JSONC configuration
//   flowdeck migrate              Migrate from upstream to fork identity
//   flowdeck rollback             Rollback from backup
//   flowdeck uninstall            Remove plugin registration
//   flowdeck dry-run              Show what would be done
//   flowdeck --help               Show help

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfig as readConfigFile, createBackup, atomicWrite, writeConfig } from "../scripts/config-mutator.mjs";
import { runDoctorChecks } from "../scripts/doctor-engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const PKG_NAME = "@heidi-dang/flowdeck";

// Try loading package.json for version info
let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch { /* ignore */ }

const args = process.argv.slice(2);
const command = args[0] || "install";

// ─── Help ──────────────────────────────────────────────────────────────
if (command === "--help" || command === "-h" || command === "help") {
  console.log(`
FlowDeck v${PKG_VERSION} — Heidi fork
Structured planning and execution workflows for OpenCode

Usage:
  flowdeck install              Install plugin in opencode.json
  flowdeck install --project    Install in project .opencode/
  flowdeck install --local-repo Install from local checkout
  flowdeck update               Update plugin registration
  flowdeck verify               Verify fork identity and registration
  flowdeck doctor               Run comprehensive diagnostics
  flowdeck config validate      Validate JSON/JSONC configuration
  flowdeck migrate              Migrate from upstream to fork identity
  flowdeck rollback             Rollback from backup
  flowdeck uninstall            Remove plugin registration
  flowdeck dry-run              Show what would be done
  flowdeck --help               Show this help

Package: ${PKG_NAME}
Version: ${PKG_VERSION}
`);
  process.exit(0);
}

// ─── Utilities ─────────────────────────────────────────────────────────

function getConfigDir(isLocal = false) {
  if (isLocal) return join(process.cwd(), ".opencode");
  return process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"));
}

/**
 * Read a config directory's opencode.json.
 * Wraps the shared readConfig to maintain the richer return shape
 * used throughout this CLI.
 */
function readConfig(configDir) {
  const configFile = join(configDir, "opencode.json");
  if (!existsSync(configFile)) return { existing: null, raw: null, path: configFile, configDir };
  const result = readConfigFile(configFile);
  if (!result.ok) {
    return { existing: null, raw: result.rawContent ?? null, path: configFile, configDir, parseError: result.error };
  }
  return { existing: result.data, raw: result.rawContent ?? null, path: configFile, configDir };
}

// ─── Registration (Transactional) ──────────────────────────────────────

/**
 * Register FlowDeck plugin in opencode.json.
 *
 * Implements a full transactional flow:
 *   1. Read and validate config
 *   2. Determine exact intended edits (plugin ref, default_agent)
 *   3. Create backup (MUST succeed or abort entirely)
 *   4. Write provisional manifest (if this fails, restore backup and abort)
 *   5. Apply config edits atomically (if this fails, restore backup, remove manifest, abort)
 *   6. Finalize manifest atomically (if this fails, restore backup, remove manifest, abort)
 *   7. Report success
 *
 * @param {string} configDir - Config directory path
 * @param {object} options
 * @param {string} options.pluginRef - Plugin reference to register
 * @param {string} options.installationMode - "npm" | "project" | "local-repo" | "postinstall" | "migrate"
 * @param {string|null} options.checkoutPath - Absolute checkout path for local-repo mode
 * @returns {{ ok: boolean, changed?: boolean, error?: string }}
 */
function registerPlugin(configDir, { pluginRef, installationMode, checkoutPath }) {
  mkdirSync(configDir, { recursive: true });
  const cfg = readConfig(configDir);

  // Step 1: Validate config
  if (cfg.raw && cfg.parseError) {
    console.log(`✗ Configuration is malformed: ${cfg.parseError}`);
    console.log("  Preserving file byte-for-byte without mutation.");
    console.log(`  File: ${cfg.path}`);
    return { ok: false, error: "malformed_config" };
  }

  const data = cfg.existing || {};
  const configFile = cfg.path;

  // Step 2: Determine exact intended edits before writing anything
  const pluginPreviouslyPresent = Array.isArray(data.plugin) && data.plugin.some(p => {
    if (pluginRef.startsWith("file://")) return p === pluginRef;
    return p === pluginRef || String(p).startsWith(pluginRef + "@");
  });
  const previousDefaultAgent = data.default_agent ?? null;
  const pluginAdded = !pluginPreviouslyPresent;
  const defaultAgentAdded = data.default_agent == null;

  const edits = [];
  if (pluginAdded) {
    edits.push({ path: ["plugin"], value: [...(data.plugin || []), pluginRef] });
  }
  if (defaultAgentAdded) {
    edits.push({ path: ["default_agent"], value: "heidi" });
  }

  if (edits.length === 0) {
    console.log(`\n✓ No changes needed.`);
    return { ok: true, changed: false };
  }

  const manifestPath = join(configDir, ".flowdeck-manifest.json");
  let backupPath = null;
  let manifestWritten = false;

  try {
    // Step 3: Create backup (MUST succeed or abort entirely)
    if (existsSync(configFile)) {
      backupPath = createBackup(configFile);
      if (!backupPath) {
        throw new Error("Backup failed — no backup file created");
      }
      console.log(`  ✓ Backup created: ${basename(backupPath)}`);
    }

    // Step 4: Write provisional manifest (if this fails, restore backup and abort)
    const manifest = {
      schemaVersion: 2,
      pluginRef,
      pluginAdded,
      pluginPreviouslyPresent,
      defaultAgentAdded,
      previousDefaultAgent,
      installationMode,
      configPath: configFile,
      checkoutPath: checkoutPath || null,
      version: PKG_VERSION,
      backupPath: backupPath || null,
      installedAt: new Date().toISOString(),
    };

    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    manifestWritten = true;
    console.log(`  ✓ Install manifest created`);

    // Step 5: Apply config edits atomically
    const writeResult = writeConfig(configFile, cfg.raw || "{}", edits);
    if (!writeResult.ok) {
      throw new Error(`Configuration write failed: ${writeResult.error}`);
    }

    // Step 6: manifest is already finalized with backupPath from step 3

    if (pluginAdded) console.log(`  ✓ Added ${pluginRef} to plugin list`);
    if (defaultAgentAdded) console.log(`  ✓ Set default_agent to heidi`);

    console.log(`\n✓ FlowDeck installed (comments preserved).`);
    console.log(`  A fresh OpenCode session is required to activate.`);
    return { ok: true, changed: true };
  } catch (err) {
    console.log(`✗ ${err.message}`);

    // Rollback: restore backup if config file exists and backup is available
    if (backupPath && existsSync(backupPath) && existsSync(configFile)) {
      try {
        copyFileSync(backupPath, configFile);
        console.log(`  ✓ Configuration rolled back from backup`);
      } catch (restoreErr) {
        console.log(`  ⚠ Backup exists at ${backupPath} but could not be restored: ${restoreErr.message}`);
      }
    }

    // Remove manifest if it was written
    if (manifestWritten && existsSync(manifestPath)) {
      try { unlinkSync(manifestPath); } catch { /* best-effort cleanup */ }
    }

    return { ok: false, error: err.message };
  }
}

// ─── Commands ──────────────────────────────────────────────────────────

async function cmdInstall() {
  const isProject = args.includes("--project") || args.includes("-p");
  const isLocalRepo = args.includes("--local-repo") || args.includes("--local");

  let pluginRef = PKG_NAME;
  let installationMode = "npm";
  let checkoutPath = null;
  let configDir;

  if (isLocalRepo) {
    const absPath = resolve(PKG_ROOT);
    pluginRef = pathToFileURL(absPath).href;
    installationMode = "local-repo";
    checkoutPath = absPath;
    configDir = getConfigDir(false);

    console.log(`Installing FlowDeck from local repository...\n`);
    console.log(`  Package: ${PKG_NAME}`);
    console.log(`  Version: ${PKG_VERSION}`);
    console.log(`  Source:  ${absPath}\n`);
  } else if (isProject) {
    installationMode = "project";
    configDir = getConfigDir(true);

    console.log(`Installing FlowDeck for this project...\n`);
  } else {
    configDir = getConfigDir(false);
    console.log(`Installing FlowDeck (${PKG_NAME} v${PKG_VERSION})...\n`);
  }

  const result = registerPlugin(configDir, { pluginRef, installationMode, checkoutPath });

  if (!result.ok) {
    process.exit(1);
  }

  if (isLocalRepo) {
    console.log(`  Installed from local repository.`);
    console.log(`  Config: ${configDir}`);
    console.log(`  Source: ${checkoutPath}`);
  }
}

async function cmdUpdate() {
  console.log(`Updating FlowDeck (${PKG_NAME})...\n`);

  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];

  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;

    console.log(`Checking ${label} config at: ${dir}`);
    const cfg = readConfig(dir);

    if (!cfg.existing || !Array.isArray(cfg.existing.plugin)) {
      console.log(`  - No plugin list found`);
      continue;
    }

    // Preserve all settings, just ensure package reference is correct
    const needsUpdate = cfg.existing.plugin.some(
      p => p === "@dv.nghiem/flowdeck" || String(p).startsWith("@dv.nghiem/flowdeck@")
    );

    if (needsUpdate) {
      console.log(`  ⚠ Found legacy @dv.nghiem/flowdeck reference — migrating...`);
      const edits = [{
        path: ["plugin"],
        value: cfg.existing.plugin.map(p =>
          p === "@dv.nghiem/flowdeck" || String(p).startsWith("@dv.nghiem/flowdeck@")
            ? PKG_NAME : p
        ),
      }];

      const result = writeConfig(cfg.path, cfg.raw || "{}", edits);
      if (result.ok) {
        console.log(`  ✓ Migrated to ${PKG_NAME}`);
      } else {
        console.log(`  ✗ Migration failed: ${result.error}`);
      }
    } else {
      console.log(`  ✓ Already up-to-date`);
    }
  }

  console.log(`\n✓ Update complete.`);
}

async function cmdVerify() {
  console.log(`Verifying FlowDeck installation...\n`);
  let pass = 0;
  let fail = 0;

  // Check 1: Package identity in root
  console.log(`[1] Package identity...`);
  const pkgRefs = [
    { label: "package.json name", file: join(PKG_ROOT, "package.json"), check: (c) => c.includes('"@heidi-dang/flowdeck"') },
  ];
  for (const { label, file, check } of pkgRefs) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8");
      if (check(content)) {
        console.log(`  ✓ ${label}: @heidi-dang/flowdeck`);
        pass++;
      } else {
        console.log(`  ✗ ${label}: NOT @heidi-dang/flowdeck`);
        fail++;
      }
    }
  }

  // Check 2: Global config registration
  const globalDir = getConfigDir(false);
  const globalCfg = readConfig(globalDir);
  if (globalCfg.existing) {
    const hasFork = Array.isArray(globalCfg.existing.plugin) &&
      globalCfg.existing.plugin.some(p => p === PKG_NAME || String(p).startsWith(PKG_NAME + "@") || String(p).startsWith("file://"));
    const hasUpstream = Array.isArray(globalCfg.existing.plugin) &&
      globalCfg.existing.plugin.some(p => String(p).includes("dv.nghiem"));

    if (hasFork) {
      console.log(`  ✓ Global config: ${PKG_NAME} registered`);
      pass++;
    } else if (hasUpstream) {
      console.log(`  ✗ Global config: points to upstream @dv.nghiem/flowdeck`);
      fail++;
    } else {
      console.log(`  - Global config: FlowDeck not registered`);
    }

    if (globalCfg.existing.default_agent === "heidi") {
      console.log(`  ✓ Default agent: heidi`);
      pass++;
    } else if (globalCfg.existing.default_agent) {
      console.log(`  - Default agent: ${globalCfg.existing.default_agent}`);
    }
  } else {
    console.log(`  - Global config: not found`);
  }

  // Check 3: Project config
  const projectDir = getConfigDir(true);
  const projectCfg = readConfig(projectDir);
  if (projectCfg.existing) {
    const hasFork = Array.isArray(projectCfg.existing.plugin) &&
      projectCfg.existing.plugin.some(p => p === PKG_NAME || String(p).startsWith(PKG_NAME + "@"));
    if (hasFork) {
      console.log(`  ✓ Project config: ${PKG_NAME} registered`);
      pass++;
    }
  }

  // Check 4: Local-repo resolution (verifies manifest checkoutPath matches current checkout)
  console.log(`[4] Local-repo resolution...`);
  let localRepoOk = false;
  for (const { dir, label } of [
    { dir: globalDir, label: "global" },
    { dir: projectDir, label: "project" },
  ]) {
    const manifestPath = join(dir, ".flowdeck-manifest.json");
    try {
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.installationMode === "local-repo" && manifest.checkoutPath) {
          const resolvedCheckout = resolve(manifest.checkoutPath);
          const currentRoot = resolve(PKG_ROOT);
          if (resolvedCheckout === currentRoot) {
            console.log(`  ✓ ${label}: Local repo checkout resolves to current: ${resolvedCheckout}`);
            localRepoOk = true;
            pass++;
          } else {
            console.log(`  ✗ ${label}: Local repo checkout mismatch — manifest: ${resolvedCheckout}, current: ${currentRoot}`);
            fail++;
          }
        }
      }
    } catch { /* skip unreadable manifests */ }
  }
  if (!localRepoOk) {
    console.log(`  - No local-repo installation found (or manifest not readable)`);
  }

  // Check 5: Package version
  console.log(`  ✓ Version: ${PKG_VERSION}`);
  pass++;

  const total = pass + fail;
  console.log(`\nResults: ${pass}/${total} passed${fail > 0 ? `, ${fail} failed` : ""}`);
  if (fail > 0) process.exit(1);
  else console.log(`\n✓ Verification passed.`);
}

async function cmdDoctor() {
  console.log(`FlowDeck Doctor — Comprehensive Diagnostics\n`);
  console.log(`Package: ${PKG_NAME}`);
  console.log(`Version: ${PKG_VERSION}\n`);

  // Check installation mode from manifest for display
  for (const { dir, label } of [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ]) {
    const manifestPath = join(dir, ".flowdeck-manifest.json");
    try {
      if (existsSync(manifestPath)) {
        const manifestRaw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestRaw);
        const mode = manifest.installationMode || "unknown";
        let modeLabel = mode;
        if (mode === "npm") modeLabel = "npm (global)";
        else if (mode === "project") modeLabel = "project (local .opencode/)";
        else if (mode === "local-repo") modeLabel = "local repository checkout";
        else if (mode === "postinstall") modeLabel = "npm postinstall";
        else if (mode === "migrate") modeLabel = "migration from upstream";
        console.log(`  ${label} install mode: ${modeLabel}`);

        if (manifest.checkoutPath) {
          console.log(`  ${label} checkout path: ${manifest.checkoutPath}`);
        }
        console.log();
      }
    } catch { /* no manifest found — normal for uninstalled */ }
  }

  const report = await runDoctorChecks(PKG_ROOT);

  console.log("\n── Diagnostics ──\n");
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    console.log(` ${icon} ${check.name}: ${check.message}`);
    if (check.remediation) console.log(`    Remedy: ${check.remediation}`);
  }

  console.log(`\n── Summary ──`);
  console.log(`  Passed: ${report.passed}`);
  console.log(`  Warned: ${report.warned}`);
  console.log(`  Failed: ${report.failed}`);
  console.log(`  Status: ${report.failed > 0 ? "UNHEALTHY" : report.warned > 0 ? "DEGRADED" : "HEALTHY"}`);

  if (report.failed > 0) process.exit(1);
}

async function cmdConfigValidate() {
  const configDir = getConfigDir(args.includes("--project") || args.includes("-p"));
  const cfg = readConfig(configDir);

  if (!cfg.raw) {
    console.log(`Config not found at: ${cfg.path}`);
    process.exit(1);
  }

  if (cfg.parseError) {
    console.log(`✗ Malformed JSON/JSONC:`);
    console.log(`  File: ${cfg.path}`);
    console.log(`  Error: ${cfg.parseError}`);
    process.exit(1);
  }

  // Check if it's JSONC (has comments)
  const isJsonc = cfg.raw.includes("//") || cfg.raw.includes("/*");
  console.log(`✓ Valid ${isJsonc ? "JSONC" : "JSON"} configuration`);
  console.log(`  File: ${cfg.path}`);

  // Validate structure
  const data = cfg.existing;
  if (data) {
    if (Array.isArray(data.plugin)) {
      console.log(`  Plugin entries: ${data.plugin.length}`);
      const forkRef = data.plugin.filter(p => String(p).includes("heidi-dang"));
      const upstreamRef = data.plugin.filter(p => String(p).includes("dv.nghiem"));
      if (forkRef.length > 0) console.log(`  ✓ Fork identity present: ${forkRef.join(", ")}`);
      if (upstreamRef.length > 0) console.log(`  ⚠ Upstream reference present: ${upstreamRef.join(", ")}`);
    }
    if (data.default_agent) console.log(`  Default agent: ${data.default_agent}`);
    if (data.agent) console.log(`  Agent overrides: ${Object.keys(data.agent).length}`);
    if (data.mcp) console.log(`  MCP servers: ${Object.keys(data.mcp).length}`);
    if (data.governance) console.log(`  Governance: configured`);
  }
}

async function cmdMigrate() {
  console.log(`Migrating to ${PKG_NAME}...\n`);

  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];

  let migrated = 0;
  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;

    // ── Step 1: Read and validate config ──────────────────────────────
    const cfg = readConfig(dir);
    if (!cfg.existing) {
      console.log(`  ${label}: No configuration found`);
      continue;
    }

    // Reject malformed config — never mutate garbage
    if (cfg.raw && cfg.parseError) {
      console.log(`  ✗ ${label}: Configuration is malformed: ${cfg.parseError}`);
      console.log(`    File: ${cfg.path}`);
      console.log(`    Fix the syntax error and re-run the migration.`);
      continue;
    }

    const data = JSON.parse(JSON.stringify(cfg.existing));
    const configFile = cfg.path;
    const manifestPath = join(dir, ".flowdeck-manifest.json");

    // ── Step 2: Determine exact intended edits ───────────────────────
    const edits = [];
    const manifest = {
      schemaVersion: 2,
      pluginRef: PKG_NAME,
      pluginAdded: false,
      pluginPreviouslyPresent: false,
      defaultAgentAdded: false,
      previousDefaultAgent: null,
      installationMode: "migrate",
      configPath: configFile,
      checkoutPath: null,
      version: PKG_VERSION,
      backupPath: null,
      installedAt: new Date().toISOString(),
    };

    // Migrate plugin references
    if (Array.isArray(data.plugin)) {
      const hasUpstream = data.plugin.some(p => String(p).includes("dv.nghiem"));
      const hasFork = data.plugin.some(p => p === PKG_NAME);

      if (hasUpstream && !hasFork) {
        const updated = data.plugin.map(p =>
          String(p).includes("dv.nghiem") ? PKG_NAME : p
        );
        edits.push({ path: ["plugin"], value: updated });
        manifest.pluginAdded = true;
        manifest.pluginPreviouslyPresent = false;
        console.log(`  ${label}: Migrated plugin reference from @dv.nghiem/flowdeck → ${PKG_NAME}`);
      }
    }

    // Set default agent if empty
    if (data.default_agent == null) {
      manifest.defaultAgentAdded = true;
      manifest.previousDefaultAgent = null;
      edits.push({ path: ["default_agent"], value: "heidi" });
      console.log(`  ${label}: Set default_agent to heidi`);
    } else {
      manifest.previousDefaultAgent = data.default_agent;
    }

    if (edits.length === 0) {
      console.log(`  ${label}: No migration needed`);
      continue;
    }

    // ── Transactional migration ──────────────────────────────────────
    let backupPath = null;
    let manifestWritten = false;

    try {
      // Step 3: Create backup (MUST succeed or abort entirely)
      if (existsSync(configFile)) {
        backupPath = createBackup(configFile);
        if (!backupPath) {
          throw new Error("Backup failed — no backup file created");
        }
        console.log(`  ✓ ${label}: Backup created: ${basename(backupPath)}`);
      }

      manifest.backupPath = backupPath;

      // Step 4: Write provisional manifest
      atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      manifestWritten = true;

      // Step 5: Apply edits atomically
      const writeResult = writeConfig(configFile, cfg.raw || "{}", edits);
      if (!writeResult.ok) {
        throw new Error(`Configuration write failed: ${writeResult.error}`);
      }

      // Step 6: Finalize manifest (manifest is already correct at this point)
      migrated++;

      console.log(`  ✓ ${label}: Migration complete`);
    } catch (err) {
      console.log(`  ✗ ${label}: Migration failed: ${err.message}`);

      // Step 7: On failure — restore backup, remove manifest, report error
      if (backupPath && existsSync(backupPath) && existsSync(configFile)) {
        try {
          copyFileSync(backupPath, configFile);
          console.log(`  ✓ ${label}: Configuration rolled back from backup`);
        } catch (restoreErr) {
          console.log(`  ⚠ ${label}: Backup exists at ${backupPath} but could not be restored: ${restoreErr.message}`);
        }
      }

      if (manifestWritten && existsSync(manifestPath)) {
        try { unlinkSync(manifestPath); } catch { /* best-effort cleanup */ }
      }

      // Continue to next config dir
    }
  }

  if (migrated > 0) {
    console.log(`\n✓ Migrated ${migrated} configuration(s).`);
  } else {
    console.log(`\n✓ Already using ${PKG_NAME}.`);
  }
}

async function cmdRollback() {
  console.log(`Rolling back FlowDeck configuration...\n`);

  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];

  let rolledBack = 0;
  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;

    // Find the most recent backup
    let backups = [];
    try {
      const files = readdirSync(dir);
      backups = files
        .filter(f => f.startsWith("opencode.json.bak.") || f.endsWith(".pre-install.bak") || f.endsWith(".pre-rollback.bak"))
        .map(f => ({ name: f, path: join(dir, f) }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch { /* ignore */ }

    if (backups.length === 0) {
      console.log(`  ${label}: No backups found`);
      continue;
    }

    const latest = backups[0];
    const configFile = join(dir, "opencode.json");

    // Create backup of current state before rollback
    if (existsSync(configFile)) {
      const preRollbackPath = createBackup(configFile);
      if (preRollbackPath) {
        console.log(`  ${label}: Pre-rollback backup: ${basename(preRollbackPath)}`);
      }
    }

    copyFileSync(latest.path, configFile);
    console.log(`  ${label}: Rolled back using ${latest.name}`);
    rolledBack++;
  }

  if (rolledBack > 0) {
    console.log(`\n✓ Rolled back ${rolledBack} configuration(s). A fresh OpenCode session is required.`);
  } else {
    console.log(`\nNo backups found to roll back.`);
  }
}

async function cmdUninstall() {
  const isProject = args.includes("--project") || args.includes("-p");
  const force = args.includes("--force") || args.includes("-f");
  const configDir = getConfigDir(isProject);
  const cfg = readConfig(configDir);

  console.log(`Uninstalling FlowDeck from: ${configDir}\n`);

  if (!cfg.existing) {
    console.log(`  Config not found at: ${cfg.path}`);
    console.log(`\n✓ Already uninstalled.`);
    return;
  }

  // ── READ MANIFEST ───────────────────────────────────────────────────
  const manifestPath = join(configDir, ".flowdeck-manifest.json");
  let manifest = null;
  try {
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }
  } catch { /* silently ignore corrupt manifest */ }

  const data = JSON.parse(JSON.stringify(cfg.existing));
  const edits = [];
  let changed = false;

  if (manifest && manifest.pluginRef) {
    // ── MANIFEST EXISTS: respect ownership fields exactly ────────────
    console.log(`  ✓ Found install manifest (schema v${manifest.schemaVersion ?? 1})`);

    // Only remove plugin ref when FlowDeck added it
    if (manifest.pluginAdded === true) {
      if (Array.isArray(data.plugin)) {
        const pluginRef = manifest.pluginRef;
        const filtered = data.plugin.filter(p => {
          if (pluginRef.startsWith("file://")) return p !== pluginRef;
          return p !== pluginRef && !String(p).startsWith(pluginRef + "@");
        });
        if (filtered.length < data.plugin.length) {
          edits.push({ path: ["plugin"], value: filtered.length > 0 ? filtered : [] });
          console.log(`  ✓ Removed ${pluginRef} from plugin list`);
          changed = true;
        }
      }
    } else if (manifest.pluginPreviouslyPresent === true) {
      console.log(`  ℹ Plugin was pre-existing — not removing`);
    } else {
      console.log(`  ℹ Plugin was not added by this installation — not removing`);
    }

    // Only handle default_agent when FlowDeck added it
    if (manifest.defaultAgentAdded === true) {
      if (manifest.previousDefaultAgent !== null && manifest.previousDefaultAgent !== undefined) {
        // Restore the value that existed before FlowDeck set it
        edits.push({ path: ["default_agent"], value: manifest.previousDefaultAgent });
        console.log(`  ✓ Restored default_agent to "${manifest.previousDefaultAgent}"`);
        changed = true;
      } else {
        // FlowDeck set it with no prior value — remove the property
        edits.push({ path: ["default_agent"], value: undefined });
        console.log(`  ✓ Removed default_agent (was set by FlowDeck)`);
        changed = true;
      }
    } else {
      console.log(`  ℹ default_agent was not set by this installation — not touching`);
    }
  } else {
    // ── NO MANIFEST: ownership-safe uninstall ────────────────────────
    console.log(`  ⚠ No install manifest found.`);

    if (!force) {
      console.log(`  ┌─ Ownership protection ──────────────────────────────`);
      console.log(`  │ Without a manifest, FlowDeck cannot safely determine`);
      console.log(`  │ which config changes it owns. To protect pre-existing`);
      console.log(`  │ settings, only --force uninstall will proceed.`);
      console.log(`  │`);
      console.log(`  │ Usage: flowdeck uninstall --force`);
      console.log(`  └─────────────────────────────────────────────────────`);
      console.log(`\n⚠ Uninstall aborted — no changes made.`);
      return;
    }

    // --force: only remove exact plugin ref match; NEVER touch default_agent
    console.log(`  ─ Forced uninstall — removing only exact plugin reference`);
    if (Array.isArray(data.plugin)) {
      const filtered = data.plugin.filter(p => p !== PKG_NAME && !String(p).startsWith(PKG_NAME + "@"));
      if (filtered.length < data.plugin.length) {
        edits.push({ path: ["plugin"], value: filtered.length > 0 ? filtered : [] });
        console.log(`  ✓ Removed ${PKG_NAME} from plugin list`);
        changed = true;
      } else {
        console.log(`  - ${PKG_NAME} not found in plugin list`);
      }
    }
    console.log(`  ℹ default_agent preserved — no manifest to authorize removal`);
  }

  if (changed) {
    // Create backup before mutation (caller responsibility now that writeConfig doesn't create backups)
    let uninstallBackupPath = null;
    if (existsSync(cfg.path)) {
      try {
        uninstallBackupPath = createBackup(cfg.path);
      } catch { /* non-fatal for uninstall */ }
    }

    const result = writeConfig(cfg.path, cfg.raw || "{}", edits);
    if (!result.ok) {
      console.log(`✗ Failed to write configuration: ${result.error}`);
      return;
    }
    if (uninstallBackupPath) console.log(`  ✓ Backup: ${basename(uninstallBackupPath)}`);

    // Clean up manifest
    if (manifest && manifest.pluginRef) {
      try { unlinkSync(manifestPath); } catch { /* ignore */ }
    }

    console.log(`\n✓ FlowDeck uninstalled.`);
  } else {
    console.log(`  ✓ No changes needed.`);
  }
}

async function cmdDryRun() {
  console.log(`DRY RUN — No files modified\n`);

  const dirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];

  for (const { dir, label } of dirs) {
    console.log(`[${label}] ${dir}`);
    const cfg = readConfig(dir);
    if (cfg.existing) {
      console.log(`  Config file: ${cfg.path}`);
      console.log(`  Plugin entries: ${cfg.existing.plugin?.length || 0}`);
      console.log(`  Default agent: ${cfg.existing.default_agent || "not set"}`);
      if (cfg.existing.plugin?.some(p => String(p).includes("dv.nghiem"))) {
        console.log(`  ⚠ Upstream reference: @dv.nghiem/flowdeck`);
      }
    } else {
      console.log(`  Not configured`);
    }
    console.log();
  }

  console.log(`Dry run complete. Use: flowdeck install`);
}

// ─── Dispatch ──────────────────────────────────────────────────────────

const handlers = {
  install: cmdInstall,
  update: cmdUpdate,
  verify: cmdVerify,
  doctor: cmdDoctor,
  uninstall: cmdUninstall,
  "dry-run": cmdDryRun,
  "config validate": cmdConfigValidate,
  migrate: cmdMigrate,
  rollback: cmdRollback,
};

// Handle "config validate" as a two-word command
const handlerKey = args.length >= 2 && args[0] === "config" && args[1] === "validate"
  ? "config validate"
  : command;

if (handlers[handlerKey]) {
  handlers[handlerKey]().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  console.error(`Run: flowdeck --help`);
  process.exit(1);
}
