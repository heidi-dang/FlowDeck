#!/usr/bin/env node
/**
 * src/cli/flowdeck.mjs — Canonical FlowDeck CLI implementation
 *
 * Single source of truth for all CLI commands.
 * Exports main(argv, runtime) for testing without process.exit.
 *
 * Commands:
 *   install              Install plugin in opencode.json
 *   install --project    Install in project .opencode/
 *   install --local-repo Install from local checkout
 *   clean-install        Atomic clean reinstall with rollback
 *   update               Update plugin registration
 *   verify               Verify fork identity and registration
 *   doctor               Run comprehensive diagnostics
 *   config validate      Validate JSON/JSONC configuration
 *   migrate              Migrate from upstream to fork identity
 *   rollback             Rollback from backup
 *   uninstall            Remove plugin registration
 *   dry-run              Show what would be done
 */

import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { readConfig as readConfigFile } from "../../scripts/config-mutator.mjs";
import { executeTransaction, executeRollbackTransaction } from "../../scripts/config-transaction.mjs";
import { runCleanInstall } from "../../scripts/clean-install-engine.mjs";
import { runDoctor as runNewDoctor, formatReport, KNOWN_PROFILES as _KNOWN_PROFILES, resolveDoctorExitCode } from "../../scripts/doctor-service.mjs";

const DOCTOR_KNOWN_PROFILES = _KNOWN_PROFILES ?? new Set(["minimal", "recommended-dev", "full-dev", "ci", "release"]);

const CWD = process.cwd();

/**
 * Resolve package root relative to this file's location.
 */
function resolvePkgRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "..", "..");
}

const PKG_ROOT = resolvePkgRoot();
const PKG_NAME = "@heidi-dang/flowdeck";
let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch { /* ignore */ }

// ─── Utilities ─────────────────────────────────────────────────────────

function getConfigDir(isLocal = false) {
  if (isLocal) return join(CWD, ".opencode");
  return process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"));
}

function readConfig(configDir) {
  const configFile = join(configDir, "opencode.json");
  if (!existsSync(configFile)) return { existing: null, raw: null, path: configFile, configDir };
  const result = readConfigFile(configFile);
  if (!result.ok) {
    return { existing: null, raw: result.rawContent ?? null, path: configFile, configDir, parseError: result.error };
  }
  return { existing: result.data, raw: result.rawContent ?? null, path: configFile, configDir };
}

function extractArg(args, name) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

// ─── Registration ──────────────────────────────────────────────────────

async function registerPlugin(configDir, { pluginRef, installationMode, checkoutPath }) {
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "opencode.json");
  const manifestPath = join(configDir, ".flowdeck-manifest.json");
  const cfg = readConfig(configDir);

  if (cfg.raw && cfg.parseError) {
    console.log(`✗ Configuration is malformed: ${cfg.parseError}`);
    console.log("  Preserving file byte-for-byte without mutation.");
    console.log(`  File: ${cfg.path}`);
    return { ok: false, error: "malformed_config" };
  }

  const data = cfg.existing || {};
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

  const result = await executeTransaction({
    configPath,
    edits,
    manifest: {
      schemaVersion: 2,
      pluginRef,
      pluginAdded,
      pluginPreviouslyPresent,
      defaultAgentAdded,
      previousDefaultAgent,
      installationMode,
      checkoutPath: checkoutPath || null,
      version: PKG_VERSION,
    },
    manifestPath,
  });

  if (result.ok) {
    if (pluginAdded) console.log(`  ✓ Added ${pluginRef} to plugin list`);
    if (defaultAgentAdded) console.log(`  ✓ Set default_agent to heidi`);
    console.log(`\n✓ FlowDeck installed (comments preserved).`);
    console.log(`  A fresh OpenCode session is required to activate.`);
    return { ok: true, changed: true };
  } else {
    console.log(`✗ ${result.error}`);
    return { ok: false, error: result.error };
  }
}

// ─── Command handlers ──────────────────────────────────────────────────

async function cmdInstall(args) {
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

  const result = await registerPlugin(configDir, { pluginRef, installationMode, checkoutPath });
  if (!result.ok) return { exitCode: 1 };

  if (isLocalRepo) {
    console.log(`  Installed from local repository.`);
    console.log(`  Config: ${configDir}`);
    console.log(`  Source: ${checkoutPath}`);
  }
  return { exitCode: 0 };
}

async function cmdUpdate(args) {
  console.log(`Updating FlowDeck (${PKG_NAME})...\n`);
  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];
  let anyFailure = false;

  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;
    const configPath = join(dir, "opencode.json");
    const manifestPath = join(dir, ".flowdeck-manifest.json");
    let edits = [];
    let needsUpdate = false;
    const cfg = readConfig(dir);

    if (cfg.existing && Array.isArray(cfg.existing.plugin)) {
      const hasUpstream = cfg.existing.plugin.some(p => String(p).includes("dv.nghiem"));
      const hasOutdated = cfg.existing.plugin.some(p => String(p).startsWith(PKG_NAME + "@"));
      if (hasUpstream || hasOutdated) {
        edits.push({
          path: ["plugin"],
          value: cfg.existing.plugin.map(p => {
            if (String(p).includes("dv.nghiem")) return PKG_NAME;
            if (String(p).startsWith(PKG_NAME + "@")) return PKG_NAME;
            return p;
          }),
        });
        needsUpdate = true;
      }
    }

    if (!needsUpdate) {
      console.log(`  ${label}: Already up-to-date`);
      continue;
    }

    const result = await executeTransaction({
      configPath, edits,
      manifest: {
        schemaVersion: 2, pluginRef: PKG_NAME,
        pluginAdded: false, pluginPreviouslyPresent: true,
        defaultAgentAdded: false, previousDefaultAgent: null,
        installationMode: "update", version: PKG_VERSION,
      },
      manifestPath,
    });

    if (result.ok) {
      console.log(`  ${label}: Updated successfully`);
    } else {
      console.error(`  ${label}: Update FAILED: ${result.error}`);
      anyFailure = true;
    }
  }

  if (anyFailure) {
    console.error("\n✗ Update failed for one or more targets");
    return { exitCode: 1 };
  }
  console.log("\n✓ Update complete.");
  return { exitCode: 0 };
}

async function cmdVerify(args) {
  console.log(`Verifying FlowDeck installation...\n`);
  let pass = 0, fail = 0;

  // Check 1: Package identity
  console.log(`[1] Package identity...`);
  const pkgRefs = [
    { label: "package.json name", file: join(PKG_ROOT, "package.json"), check: (c) => c.includes('"@heidi-dang/flowdeck"') },
  ];
  for (const { label, file, check } of pkgRefs) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8");
      if (check(content)) { console.log(`  ✓ ${label}: @heidi-dang/flowdeck`); pass++; }
      else { console.log(`  ✗ ${label}: NOT @heidi-dang/flowdeck`); fail++; }
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
    if (hasFork) { console.log(`  ✓ Global config: ${PKG_NAME} registered`); pass++; }
    else if (hasUpstream) { console.log(`  ✗ Global config: points to upstream @dv.nghiem/flowdeck`); fail++; }
    else { console.log(`  ✗ Global config: FlowDeck not registered`); fail++; }
    if (globalCfg.existing.default_agent === "heidi") { console.log(`  ✓ Default agent: heidi`); pass++; }
    else if (globalCfg.existing.default_agent) { console.log(`  - Default agent: ${globalCfg.existing.default_agent}`); }
  } else { console.log(`  - Global config: not found`); }

  // Check 3: Project config
  const projectDir = getConfigDir(true);
  const projectCfg = readConfig(projectDir);
  if (projectCfg.existing) {
    const hasFork = Array.isArray(projectCfg.existing.plugin) &&
      projectCfg.existing.plugin.some(p => p === PKG_NAME || String(p).startsWith(PKG_NAME + "@"));
    if (hasFork) { console.log(`  ✓ Project config: ${PKG_NAME} registered`); pass++; }
  }

  // Check 4: Local-repo resolution
  console.log(`[4] Local-repo resolution...`);
  let localRepoOk = false;
  for (const { dir, label } of [{ dir: globalDir, label: "global" }, { dir: projectDir, label: "project" }]) {
    const manifestPath = join(dir, ".flowdeck-manifest.json");
    try {
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.installationMode === "local-repo" && manifest.checkoutPath) {
          const resolvedCheckout = resolve(manifest.checkoutPath);
          const currentRoot = resolve(PKG_ROOT);
          if (resolvedCheckout === currentRoot) {
            console.log(`  ✓ ${label}: Local repo checkout resolves to current: ${resolvedCheckout}`);
            localRepoOk = true; pass++;
          } else {
            console.log(`  ✗ ${label}: Local repo checkout mismatch — manifest: ${resolvedCheckout}, current: ${currentRoot}`);
            fail++;
          }
        }
      }
    } catch { /* skip */ }
  }
  if (!localRepoOk) console.log(`  - No local-repo installation found (or manifest not readable)`);

  // Check 5: Version
  console.log(`  ✓ Version: ${PKG_VERSION}`);
  pass++;

  const total = pass + fail;
  console.log(`\nResults: ${pass}/${total} passed${fail > 0 ? `, ${fail} failed` : ""}`);
  if (fail > 0) return { exitCode: 1 };
  console.log(`\n✓ Verification passed.`);
  return { exitCode: 0 };
}

async function cmdDoctor(args) {
  const doctorArgs = args.slice(1);
  const validFlags = new Set(["--json", "--strict", "--verbose", "--apply-recommended", "--non-interactive", "--profile", "--help", "-h"]);
  let prevWasProfile = false;
  for (const a of doctorArgs) {
    if (prevWasProfile) { prevWasProfile = false; continue; }
    if (a === "--profile") { prevWasProfile = true; continue; }
    if (a.startsWith("--") && !validFlags.has(a)) {
      process.stderr.write(`Error: Unknown flag: ${a}\nUsage: flowdeck doctor [--json] [--strict] [--verbose] [--apply-recommended] [--profile <name>] [--help]\n`);
      return { exitCode: 2 };
    }
  }

  if (doctorArgs.includes("--help") || doctorArgs.includes("-h")) {
    process.stderr.write(`FlowDeck Doctor — Environment Health Checker\n\nUsage: flowdeck doctor [--json] [--strict] [--verbose] [--apply-recommended] [--profile <name>] [--non-interactive] [--help]\n\nOptions:\n  --json               Output machine-readable JSON to stdout\n  --strict             Treat warnings as failures\n  --verbose            Include detailed check output\n  --apply-recommended  Apply safe auto-fixes\n  --profile <name>     Check profile (default: recommended-dev)\n  --non-interactive    Disable interactive prompts\n  --help               Show this help message\n`);
    return { exitCode: 0 };
  }

  const isJson = doctorArgs.includes("--json");
  const isStrict = doctorArgs.includes("--strict");
  const isVerbose = doctorArgs.includes("--verbose");
  const applyFix = doctorArgs.includes("--apply-recommended");
  const profileIdx = doctorArgs.indexOf("--profile");
  const profile = profileIdx >= 0 && profileIdx + 1 < doctorArgs.length ? doctorArgs[profileIdx + 1] : "recommended-dev";

  if (!DOCTOR_KNOWN_PROFILES.has(profile)) {
    process.stderr.write(`Error: Unknown profile "${profile}". Valid profiles: ${[...DOCTOR_KNOWN_PROFILES].join(", ")}\n`);
    return { exitCode: 2 };
  }

  try {
    const rawReport = await runNewDoctor(PKG_ROOT, {
      strict: isStrict, verbose: isVerbose, applyRecommended: applyFix, profile,
    });
    const s = rawReport.summary || {};
    const errors = s.errors ?? 0;
    const warnings = s.warnings ?? 0;
    const report = {
      ...rawReport,
      packageName: PKG_NAME, packageVersion: PKG_VERSION,
      passed: s.passed ?? 0, warned: warnings, failed: errors,
      status: errors > 0 ? "unhealthy" : warnings > 0 ? "degraded" : "healthy",
    };

    if (isJson) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, ...report }, null, 2) + "\n");
    } else {
      const text = await formatReport(report, isVerbose);
      process.stdout.write(text);
    }
    return { exitCode: resolveDoctorExitCode(report, isStrict) };
  } catch (err) {
    process.stderr.write(`Doctor error: ${err.message}\n`);
    return { exitCode: 2 };
  }
}

async function cmdConfigValidate(args) {
  const configDir = getConfigDir(args.includes("--project") || args.includes("-p"));
  const cfg = readConfig(configDir);

  if (!cfg.raw) {
    console.log(`Config not found at: ${cfg.path}`);
    return { exitCode: 1 };
  }

  if (cfg.parseError) {
    console.log(`✗ Malformed JSON/JSONC:`);
    console.log(`  File: ${cfg.path}`);
    console.log(`  Error: ${cfg.parseError}`);
    return { exitCode: 1 };
  }

  const isJsonc = cfg.raw.includes("//") || cfg.raw.includes("/*");
  console.log(`✓ Valid ${isJsonc ? "JSONC" : "JSON"} configuration`);
  console.log(`  File: ${cfg.path}`);

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
  return { exitCode: 0 };
}

async function cmdMigrate(args) {
  console.log(`Migrating to ${PKG_NAME}...\n`);
  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];
  let migrated = 0, failed = 0;

  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;
    const cfg = readConfig(dir);
    if (cfg.parseError) {
      console.log(`  ✗ ${label}: Configuration is malformed: ${cfg.parseError}\n    File: ${cfg.path}\n    Fix the syntax error and re-run the migration.`);
      failed++; continue;
    }
    if (!cfg.existing) { console.log(`  ${label}: No configuration found`); continue; }

    const configPath = join(dir, "opencode.json");
    const manifestPath = join(dir, ".flowdeck-manifest.json");
    const edits = [];
    const manifest = { schemaVersion: 2, pluginRef: PKG_NAME, pluginAdded: false, pluginPreviouslyPresent: false, defaultAgentAdded: false, previousDefaultAgent: null, installationMode: "migrate", version: PKG_VERSION };

    if (Array.isArray(cfg.existing.plugin)) {
      const hasUpstream = cfg.existing.plugin.some(p => String(p).includes("dv.nghiem"));
      const hasFork = cfg.existing.plugin.some(p => p === PKG_NAME);
      if (hasUpstream && !hasFork) {
        edits.push({ path: ["plugin"], value: cfg.existing.plugin.map(p => String(p).includes("dv.nghiem") ? PKG_NAME : p) });
        manifest.pluginAdded = true;
        console.log(`  ${label}: Migrated plugin reference from @dv.nghiem/flowdeck → ${PKG_NAME}`);
      }
    }

    if (cfg.existing.default_agent == null) {
      manifest.defaultAgentAdded = true;
      manifest.previousDefaultAgent = null;
      edits.push({ path: ["default_agent"], value: "heidi" });
      console.log(`  ${label}: Set default_agent to heidi`);
    } else {
      manifest.previousDefaultAgent = cfg.existing.default_agent;
    }

    if (edits.length === 0) { console.log(`  ${label}: no migration required`); continue; }

    const result = await executeTransaction({ configPath, edits, manifest, manifestPath });
    if (result.ok) { console.log(`  ✓ ${label}: migration succeeded`); migrated++; }
    else { console.log(`  ✗ ${label}: migration failed: ${result.error}`); failed++; }
  }

  if (failed > 0) { console.log(`\n✗ migration failed`); return { exitCode: 1 }; }
  else if (migrated > 0) { console.log(`\n✓ migration succeeded`); }
  else { console.log(`\n✓ no migration required`); }
  return { exitCode: 0 };
}

async function cmdRollback(args) {
  console.log(`Rolling back FlowDeck configuration...\n`);
  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];
  let rolledBack = 0, failed = 0;

  for (const { dir, label } of configDirs) {
    if (!existsSync(dir)) continue;
    let backups = [];
    try {
      const files = readdirSync(dir);
      backups = files.filter(f => f.startsWith("opencode.json.bak.") || f.endsWith(".pre-install.bak") || f.endsWith(".pre-rollback.bak"))
        .map(f => ({ name: f, path: join(dir, f) })).sort((a, b) => b.name.localeCompare(a.name));
    } catch { /* ignore */ }
    if (backups.length === 0) { console.log(`  ${label}: No backups found`); continue; }

    const latest = backups[0];
    const result = await executeRollbackTransaction({
      configPath: join(dir, "opencode.json"), manifestPath: join(dir, ".flowdeck-manifest.json"), backupPath: latest.path,
    });
    if (result.ok) { console.log(`  ${label}: Rolled back using ${latest.name}`); rolledBack++; }
    else { console.error(`  ${label}: Rollback FAILED: ${result.error}`); failed++; }
  }

  if (failed > 0) { console.error(`\n✗ Rollback failed for one or more targets.`); return { exitCode: 1 }; }
  else if (rolledBack > 0) { console.log(`\n✓ Rolled back ${rolledBack} configuration(s). A fresh OpenCode session is required.`); }
  else { console.log(`\nNo backups found to roll back.`); }
  return { exitCode: 0 };
}

async function cmdUninstall(args) {
  const isProject = args.includes("--project") || args.includes("-p");
  const force = args.includes("--force") || args.includes("-f");
  const configDir = getConfigDir(isProject);
  const cfg = readConfig(configDir);
  console.log(`Uninstalling FlowDeck from: ${configDir}\n`);

  if (cfg.parseError) {
    console.log(`✗ Configuration is malformed: ${cfg.parseError}\n  File: ${cfg.path}`);
    return { exitCode: 1 };
  }
  if (!cfg.existing) { console.log(`  Config not found at: ${cfg.path}\n\n✓ Already uninstalled.`); return { exitCode: 0 }; }

  const configPath = cfg.path;
  const manifestPath = join(configDir, ".flowdeck-manifest.json");
  let manifest = null;
  let manifestIsCorrupt = false;
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
    catch { manifestIsCorrupt = true; }
  }
  if (manifestIsCorrupt && !force) {
    console.log(`  ✗ Install manifest at ${manifestPath} is corrupt.\n    Use --force to perform a legacy forced uninstall.`);
    return { exitCode: 1 };
  }

  const edits = [];
  let changed = false;

  if (manifest && manifest.pluginRef && !manifestIsCorrupt) {
    console.log(`  ✓ Found install manifest (schema v${manifest.schemaVersion ?? 1})`);
    if (manifest.pluginAdded === true) {
      if (Array.isArray(cfg.existing.plugin)) {
        const pluginRef = manifest.pluginRef;
        const filtered = cfg.existing.plugin.filter(p => {
          if (pluginRef.startsWith("file://")) return p !== pluginRef;
          return p !== pluginRef && !String(p).startsWith(pluginRef + "@");
        });
        if (filtered.length < cfg.existing.plugin.length) {
          edits.push({ path: ["plugin"], value: filtered.length > 0 ? filtered : [] });
          console.log(`  ✓ Removed ${pluginRef} from plugin list`);
          changed = true;
        }
      }
    } else if (manifest.pluginPreviouslyPresent === true) {
      console.log(`  ℹ Plugin was pre-existing — not removing`);
    } else { console.log(`  ℹ Plugin was not added by this installation — not removing`); }

    if (manifest.defaultAgentAdded === true) {
      if (manifest.previousDefaultAgent !== null && manifest.previousDefaultAgent !== undefined) {
        edits.push({ path: ["default_agent"], value: manifest.previousDefaultAgent });
        console.log(`  ✓ Restored default_agent to "${manifest.previousDefaultAgent}"`);
        changed = true;
      } else {
        edits.push({ path: ["default_agent"], value: undefined });
        console.log(`  ✓ Removed default_agent (was set by FlowDeck)`);
        changed = true;
      }
    } else { console.log(`  ℹ default_agent was not set by this installation — not touching`); }
  } else {
    if (!manifestIsCorrupt) console.log(`  ⚠ No install manifest found.`);
    if (!force) {
      console.log(`  ┌─ Ownership protection ──────────────────────────────\n  │ Without a manifest, FlowDeck cannot safely determine\n  │ which config changes it owns. To protect pre-existing\n  │ settings, only --force uninstall will proceed.\n  │\n  │ Usage: flowdeck uninstall --force\n  └─────────────────────────────────────────────────────\n\n⚠ Uninstall aborted — no changes made.`);
      return { exitCode: 1 };
    }
    console.log(`  ─ Forced uninstall — removing only exact plugin reference`);
    if (Array.isArray(cfg.existing.plugin)) {
      const filtered = cfg.existing.plugin.filter(p => p !== PKG_NAME && !String(p).startsWith(PKG_NAME + "@"));
      if (filtered.length < cfg.existing.plugin.length) {
        edits.push({ path: ["plugin"], value: filtered.length > 0 ? filtered : [] });
        console.log(`  ✓ Removed ${PKG_NAME} from plugin list`);
        changed = true;
      } else { console.log(`  - ${PKG_NAME} not found in plugin list`); }
    }
    console.log(`  ℹ default_agent preserved — no manifest to authorize removal`);
  }

  if (changed) {
    let result;
    if (manifest && !manifestIsCorrupt) {
      result = await executeTransaction({
        configPath, edits,
        manifest: { ...manifest, pluginAdded: false, uninstalledAt: new Date().toISOString(), installationMode: "uninstall" },
        manifestPath,
      });
    } else {
      result = await executeTransaction({ configPath, edits, manifestPath, skipManifest: true, allowCorruptManifest: force });
    }
    if (result.ok) { console.log(`\n✓ FlowDeck uninstalled. A fresh OpenCode session is required.`); }
    else { console.error(`✗ Uninstall FAILED: ${result.error}`); return { exitCode: 1 }; }
  } else { console.log(`  ✓ No changes needed.`); }
  return { exitCode: 0 };
}

async function cmdCleanInstall(args) {
  const result = await runCleanInstall({
    exactVersion: extractArg(args, "--exact-version"),
    removeLegacy: !args.includes("--no-remove-legacy"),
    verifyRuntime: !args.includes("--no-verify-runtime"),
    dryRun: args.includes("--dry-run"),
    verifyOnly: args.includes("--verify-only"),
    uninstallOnly: args.includes("--uninstall-only"),
    project: args.includes("--project") || args.includes("-p"),
    keepBackup: args.includes("--keep-backup"),
    localRepo: extractArg(args, "--local-repo"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    help: args.includes("--help") || args.includes("-h"),
  });

  if (result?.ok && !result?.dryRun) {
    console.log("\n  OPENCODE-FRESH-PROCESS-REQUIRED");
    console.log("  An existing OpenCode Web process may retain its loaded plugin/config state.");
    console.log("  Start a fresh OpenCode process to load the updated FlowDeck plugin.");
    console.log("  Do NOT stop, restart, signal, or replace an existing OpenCode process.");
  }
  if (!result?.ok) return { exitCode: 1 };
  return { exitCode: 0 };
}

async function cmdDryRun(args) {
  console.log(`DRY RUN — No files modified\n`);
  for (const { dir, label } of [{ dir: getConfigDir(false), label: "global" }, { dir: getConfigDir(true), label: "project" }]) {
    console.log(`[${label}] ${dir}`);
    const cfg = readConfig(dir);
    if (cfg.existing) {
      console.log(`  Config file: ${cfg.path}`);
      console.log(`  Plugin entries: ${cfg.existing.plugin?.length || 0}`);
      console.log(`  Default agent: ${cfg.existing.default_agent || "not set"}`);
      if (cfg.existing.plugin?.some(p => String(p).includes("dv.nghiem"))) console.log(`  ⚠ Upstream reference: @dv.nghiem/flowdeck`);
    } else { console.log(`  Not configured`); }
    console.log();
  }
  console.log(`Dry run complete. Use: flowdeck install`);
  return { exitCode: 0 };
}

// ─── Dispatch ──────────────────────────────────────────────────────────

const HANDLERS = {
  install: cmdInstall,
  update: cmdUpdate,
  verify: cmdVerify,
  doctor: cmdDoctor,
  uninstall: cmdUninstall,
  "dry-run": cmdDryRun,
  "config validate": cmdConfigValidate,
  migrate: cmdMigrate,
  rollback: cmdRollback,
  "clean-install": cmdCleanInstall,
};

/**
 * Main entry point. Parses argv and dispatches to the appropriate handler.
 *
 * @param {string[]} argv - Command-line arguments (should already be sliced from process.argv)
 * @param {object} [runtime] - Optional runtime overrides for testing
 * @param {object} [runtime.stdout] - Writable stream (default: process.stdout)
 * @param {object} [runtime.stderr] - Writable stream (default: process.stderr)
 * @returns {Promise<{exitCode: number}>}
 */
export async function main(argv = [], runtime = {}) {
  const command = argv[0] || "install";

  // Help
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(`\nFlowDeck v${PKG_VERSION} — Heidi fork\nStructured planning and execution workflows for OpenCode\n\nUsage:\n  flowdeck install              Install plugin in opencode.json\n  flowdeck install --project    Install in project .opencode/\n  flowdeck install --local-repo Install from local checkout\n  flowdeck clean-install        Atomic clean reinstall with rollback\n  flowdeck update               Update plugin registration\n  flowdeck verify               Verify fork identity and registration\n  flowdeck doctor               Run comprehensive diagnostics\n  flowdeck config validate      Validate JSON/JSONC configuration\n  flowdeck migrate              Migrate from upstream to fork identity\n  flowdeck rollback             Rollback from backup\n  flowdeck uninstall            Remove plugin registration\n  flowdeck dry-run              Show what would be done\n  flowdeck --help               Show help\n\nPackage: ${PKG_NAME}\nVersion: ${PKG_VERSION}\n`);
    return { exitCode: 0 };
  }

  // Handle "config validate" as a two-word command
  const handlerKey = argv.length >= 2 && argv[0] === "config" && argv[1] === "validate"
    ? "config validate"
    : command;

  const handler = HANDLERS[handlerKey];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run: flowdeck --help`);
    return { exitCode: 1 };
  }

  try {
    return await handler(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return { exitCode: 1 };
  }
}
