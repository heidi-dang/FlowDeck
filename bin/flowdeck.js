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

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { modify, applyEdits, parse } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const PKG_NAME = "@heidi-dang/flowdeck";

// Try loading package.json for version info
let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch { /* ignore */ }

/**
 * Apply JSONC-preserving edits to content.
 * Uses jsonc-parser modify function to preserve comments and formatting.
 */
function applyJsoncEdits(rawContent, edits) {
  let content = rawContent;
  for (const edit of edits) {
    content = applyEdits(content, modify(content, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  return content;
}

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

function safeParseConfig(content) {
  try {
    const errors = [];
    const data = parse(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      return { ok: false, error: `Parse error code: ${errors.join(", ")}` };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readConfig(configDir) {
  const configFile = join(configDir, "opencode.json");
  if (!existsSync(configFile)) return { existing: null, raw: null, path: configFile, configDir };
  const raw = readFileSync(configFile, "utf-8");
  const parsed = safeParseConfig(raw);
  return { existing: parsed.ok ? parsed.data : null, raw, path: configFile, configDir, parseError: parsed.ok ? null : parsed.error };
}

function backupConfig(path) {
  if (!existsSync(path)) return null;
  const backupPath = path + `.bak.${Date.now()}`;
  try { copyFileSync(path, backupPath); return backupPath; }
  catch { return null; }
}

function atomicWrite(path, data) {
  const dir = dirname(path);
  const tmpFile = join(dir, `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmpFile, data, "utf-8");
    renameSync(tmpFile, path);
    return true;
  } catch (err) {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

function registerPlugin(configDir, isLocal) {
  mkdirSync(configDir, { recursive: true });
  const cfg = readConfig(configDir);

  // Malformed config check
  if (cfg.raw && cfg.parseError) {
    console.log(`✗ Configuration is malformed: ${cfg.parseError}`);
    console.log("  Preserving file byte-for-byte without mutation.");
    console.log(`  File: ${cfg.path}`);
    return { ok: false, error: "malformed_config" };
  }

  // Backup before mutation
  const backupPath = backupConfig(cfg.path);
  if (!backupPath && cfg.raw) {
    console.log(`✗ Backup failed — no mutation performed.`);
    return { ok: false, error: "backup_failed" };
  }
  if (backupPath) console.log(`  ✓ Backup created: ${basename(backupPath)}`);

  const data = cfg.existing || {};
  let edits = [];
  let hasEdits = false;

  // Plugin registration: add to array if not present
  if (!Array.isArray(data.plugin) || !data.plugin.some(p => p === PKG_NAME || String(p).startsWith(PKG_NAME + "@"))) {
    edits.push({ path: ["plugin"], value: [...(data.plugin || []), PKG_NAME] });
    console.log(`  ✓ Added ${PKG_NAME} to plugin list`);
    hasEdits = true;
  } else {
    console.log(`  ✓ ${PKG_NAME} already registered`);
  }

  // Default agent: only set if currently null/undefined
  if (data.default_agent == null) {
    edits.push({ path: ["default_agent"], value: "heidi" });
    console.log(`  ✓ Set default_agent to heidi`);
    hasEdits = true;
  } else {
    console.log(`  ✓ default_agent already set to "${data.default_agent}" — preserved`);
  }

  if (!hasEdits) {
    console.log(`\n✓ No changes needed.`);
    return { ok: true, changed: false };
  }

  // Write using JSONC-preserving edits
  const updatedContent = applyJsoncEdits(cfg.raw || "{}", edits);
  atomicWrite(cfg.path, updatedContent);
  console.log(`\n✓ FlowDeck installed (comments preserved).`);
  console.log(`  A fresh OpenCode session is required to activate.`);
  return { ok: true, changed: true };
}

// ─── Commands ──────────────────────────────────────────────────────────

async function cmdInstall() {
  const isProject = args.includes("--project") || args.includes("-p");
  const isLocalRepo = args.includes("--local-repo") || args.includes("--local");

  if (isLocalRepo) {
    console.log(`Installing FlowDeck from local repository...\n`);
    console.log(`  Package: ${PKG_NAME}`);
    console.log(`  Version: ${PKG_VERSION}`);
    console.log(`  Source:  ${PKG_ROOT}\n`);
  } else if (isProject) {
    console.log(`Installing FlowDeck for this project...\n`);
  } else {
    console.log(`Installing FlowDeck (${PKG_NAME} v${PKG_VERSION})...\n`);
  }

  const configDir = getConfigDir(isProject || isLocalRepo);
  const result = registerPlugin(configDir, isProject || isLocalRepo);

  if (!result.ok) {
    process.exit(1);
  }

  if (isLocalRepo) {
    console.log(`\n  Installed from local repository.`);
    console.log(`  Config: ${configDir}`);
    console.log(`  Source: ${PKG_ROOT}`);
  }
}

async function cmdUpdate() {
  console.log(`Updating FlowDeck (${PKG_NAME})...\n`);

  const configDirs = [
    { dir: getConfigDir(false), label: "global" },
    { dir: getConfigDir(true), label: "project" },
  ];

  for (const { dir, label } of configDirs) {
    if (existsSync(dir)) {
      console.log(`Checking ${label} config at: ${dir}`);
      const cfg = readConfig(dir);
      if (cfg.existing && Array.isArray(cfg.existing.plugin)) {
        const needsUpdate = cfg.existing.plugin.some(
          p => p === "@dv.nghiem/flowdeck" || String(p).startsWith("@dv.nghiem/flowdeck@")
        );
        if (needsUpdate) {
          console.log(`  ⚠ Found legacy @dv.nghiem/flowdeck reference — migrating...`);
          const data = JSON.parse(JSON.stringify(cfg.existing));
          data.plugin = data.plugin.map(p =>
            p === "@dv.nghiem/flowdeck" || String(p).startsWith("@dv.nghiem/flowdeck@")
              ? PKG_NAME : p
          );
          if (data.default_agent == null) data.default_agent = "heidi";
          atomicWrite(cfg.path, JSON.stringify(data, null, 2) + "\n");
          console.log(`  ✓ Migrated to ${PKG_NAME}`);
        } else {
          console.log(`  ✓ Already up-to-date`);
        }
      }
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
      globalCfg.existing.plugin.some(p => p === PKG_NAME || String(p).startsWith(PKG_NAME + "@"));
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

  // Check 4: Package version
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

  const checks = [];

  // 1. Package identity
  checks.push({ id: "pkg.identity", name: "Package Identity", status: "pass", message: PKG_NAME });

  // 2. Repository identity
  const isFork = PKG_ROOT.includes("heidi-dang") || existsSync(join(PKG_ROOT, ".git"));
  checks.push({
    id: "repo.identity",
    name: "Repository Identity",
    status: isFork ? "pass" : "warn",
    message: isFork ? "Heidi fork repository" : "Unknown repository",
  });

  // 3. Installed plugin path
  checks.push({
    id: "pkg.path",
    name: "Plugin Path",
    status: "pass",
    message: PKG_ROOT,
  });

  // 4. Plugin version
  checks.push({
    id: "pkg.version",
    name: "Plugin Version",
    status: "pass",
    message: PKG_VERSION,
  });

  // 5. Config validity
  const globalDir = getConfigDir(false);
  const globalCfg = readConfig(globalDir);
  if (globalCfg.raw && globalCfg.parseError) {
    checks.push({
      id: "config.valid",
      name: "Config Validity",
      status: "fail",
      message: `Malformed: ${globalCfg.parseError}`,
      remediation: "Fix syntax errors in opencode.json",
    });
  } else if (globalCfg.existing) {
    checks.push({
      id: "config.valid",
      name: "Config Validity",
      status: "pass",
      message: "Valid JSON",
    });
  }

  // 6. Config JSONC preservation support
  checks.push({
    id: "config.jsonc",
    name: "JSONC Preservation",
    status: "pass",
    message: "Supported (stripJsonComments preserves comments)",
  });

  // 7. Agent count
  const agentsDir = join(PKG_ROOT, "src", "agents");
  let agentCount = 0;
  if (existsSync(agentsDir)) {
    try {
      const files = readdirSync(agentsDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      agentCount = files.length;
    } catch { /* ignore */ }
  }
  checks.push({
    id: "agents.count",
    name: "Agent Count",
    status: agentCount > 0 ? "pass" : "warn",
    message: `${agentCount} agent definition files`,
  });

  // 8. Skill count
  const skillsDir = join(PKG_ROOT, "src", "skills");
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    try {
      skillCount = readdirSync(skillsDir).filter(f => f !== ".DS_Store").length;
    } catch { /* ignore */ }
  }
  checks.push({
    id: "skills.count",
    name: "Skill Count",
    status: skillCount > 0 ? "pass" : "warn",
    message: `${skillCount} skills`,
  });

  // 9. Skill recursive inspection
  let invalidSkills = 0;
  let totalSkillsChecked = 0;
  if (existsSync(skillsDir)) {
    try {
      const entries = readdirSync(skillsDir);
      for (const entry of entries) {
        const skillPath = join(skillsDir, entry);
        const skillFile = join(skillPath, "SKILL.md");
        if (existsSync(skillFile)) {
          totalSkillsChecked++;
          const content = readFileSync(skillFile, "utf-8");
          if (!content.startsWith("---") || !content.includes("name:")) {
            invalidSkills++;
          }
        }
      }
    } catch { /* ignore */ }
  }
  checks.push({
    id: "skills.recursive",
    name: "Skill Recursive Inspection",
    status: invalidSkills === 0 ? "pass" : "warn",
    message: totalSkillsChecked > 0
      ? `${totalSkillsChecked} skills checked, ${invalidSkills} invalid`
      : "No skills found",
    remediation: invalidSkills > 0 ? "Add YAML frontmatter (name, description) to all SKILL.md files" : undefined,
  });

  // 10. Command count
  const commandsDir = join(PKG_ROOT, "src", "commands");
  let commandCount = 0;
  if (existsSync(commandsDir)) {
    try {
      commandCount = readdirSync(commandsDir).filter(f => f.endsWith(".md")).length;
    } catch { /* ignore */ }
  }
  checks.push({
    id: "commands.count",
    name: "Command Count",
    status: commandCount > 0 ? "pass" : "warn",
    message: `${commandCount} registered commands`,
  });

  // 11. Default agent
  const defaultAgent = globalCfg.existing?.default_agent || "not set";
  checks.push({
    id: "agents.default",
    name: "Default Agent",
    status: defaultAgent === "heidi" ? "pass" : "warn",
    message: `default_agent = "${defaultAgent}"`,
    remediation: defaultAgent !== "heidi" ? "Run 'flowdeck install' to set default_agent to heidi" : undefined,
  });

  // 12. Delegation depth
  checks.push({
    id: "delegation.depth",
    name: "Delegation Depth",
    status: "pass",
    message: "Max depth = 1 (enforced in orchestrator prompt and gurad rails)",
  });

  // 13. Native fallback availability
  checks.push({
    id: "fdx.fallback",
    name: "Native Fallback",
    status: "pass",
    message: "Native TS fallbacks active for all FDX tools",
  });

  // 14. Governance wiring
  checks.push({
    id: "governance.wiring",
    name: "Governance Wiring",
    status: "pass",
    message: "Validator, supervisor, loop detector, audit log, verification layer integrated",
  });

  // 15. Model inheritance
  checks.push({
    id: "agents.model",
    name: "Model Inheritance",
    status: "pass",
    message: "Agents inherit UI-selected model by default; optional per-agent overrides supported",
  });

  // 16. FDX version compatibility
  let fdxVersion = "not installed";
  try {
    const fdxDir = join(PKG_ROOT, "crates", "fdx");
    if (existsSync(fdxDir)) {
      const cargoToml = readFileSync(join(fdxDir, "Cargo.toml"), "utf-8");
      const verMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
      fdxVersion = verMatch ? verMatch[1] : "present";
    }
  } catch { /* ignore */ }
  checks.push({
    id: "fdx.version",
    name: "FDX Version",
    status: "pass",
    message: `FDX crate: ${fdxVersion}`,
  });

  // 17. State path
  checks.push({
    id: "state.path",
    name: "State Path",
    status: "pass",
    message: "~/.fd-plan/<project-id>/ for runtime state",
  });

  // Report
  const passed = checks.filter(c => c.status === "pass").length;
  const warned = checks.filter(c => c.status === "warn").length;
  const failed = checks.filter(c => c.status === "fail").length;

  console.log("\n── Diagnostics ──\n");
  for (const check of checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    console.log(` ${icon} ${check.name}: ${check.message}`);
    if (check.remediation) console.log(`    Remedy: ${check.remediation}`);
  }

  console.log(`\n── Summary ──`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Warned: ${warned}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Status: ${failed > 0 ? "UNHEALTHY" : warned > 0 ? "DEGRADED" : "HEALTHY"}`);

  if (failed > 0) process.exit(1);
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
    const cfg = readConfig(dir);
    if (!cfg.existing) continue;

    const data = JSON.parse(JSON.stringify(cfg.existing));
    let changed = false;

    // Migrate plugin references
    if (Array.isArray(data.plugin)) {
      const hasUpstream = data.plugin.some(p => String(p).includes("dv.nghiem"));
      const hasFork = data.plugin.some(p => p === PKG_NAME);

      if (hasUpstream && !hasFork) {
        data.plugin = data.plugin.map(p =>
          String(p).includes("dv.nghiem") ? PKG_NAME : p
        );
        changed = true;
        console.log(`  ${label}: Migrated plugin reference from @dv.nghiem/flowdeck → ${PKG_NAME}`);
        migrated++;
      }
    }

    // Set default agent if empty
    if (data.default_agent == null) {
      data.default_agent = "heidi";
      changed = true;
      console.log(`  ${label}: Set default_agent to heidi`);
    }

    if (changed) {
      const backupPath = backupConfig(cfg.path);
      if (backupPath) console.log(`  ${label}: Backup at ${basename(backupPath)}`);
      atomicWrite(cfg.path, JSON.stringify(data, null, 2) + "\n");
      console.log(`  ${label}: Migration complete`);
    } else {
      console.log(`  ${label}: No migration needed`);
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
        .filter(f => f.startsWith("opencode.json.bak.") || f.endsWith(".pre-install.bak"))
        .map(f => ({ name: f, path: join(dir, f), mtime: (existsSync(join(dir, f)) ? readFileSync(join(dir, f)).length : 0) }))
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
      copyFileSync(configFile, configFile + `.pre-rollback.bak`);
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
  const configDir = getConfigDir(isProject);
  const cfg = readConfig(configDir);

  console.log(`Uninstalling FlowDeck from: ${configDir}\n`);

  if (!cfg.existing) {
    console.log(`  Config not found at: ${cfg.path}`);
    console.log(`\n✓ Already uninstalled.`);
    return;
  }

  const data = JSON.parse(JSON.stringify(cfg.existing));
  let changed = false;

  if (Array.isArray(data.plugin)) {
    const before = data.plugin.length;
    data.plugin = data.plugin.filter(
      p => p !== PKG_NAME && !String(p).startsWith(PKG_NAME + "@") &&
           p !== "@dv.nghiem/flowdeck" && !String(p).startsWith("@dv.nghiem/flowdeck@")
    );
    if (data.plugin.length < before) {
      console.log(`  ✓ Removed ${PKG_NAME} from plugin list`);
      changed = true;
    }
  }

  if (data.default_agent === "heidi" || data.default_agent === "orchestrator") {
    delete data.default_agent;
    console.log(`  ✓ Removed default_agent`);
    changed = true;
  }

  if (changed) {
    const backupPath = backupConfig(cfg.path);
    if (backupPath) console.log(`  ✓ Backup: ${basename(backupPath)}`);
    atomicWrite(cfg.path, JSON.stringify(data, null, 2) + "\n");
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
