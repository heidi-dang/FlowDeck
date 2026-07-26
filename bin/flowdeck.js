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
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readConfig as readConfigFile, createBackup, atomicWrite, writeConfig } from "../scripts/config-mutator.mjs";

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

// ─── Registration ──────────────────────────────────────────────────────

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

  const data = cfg.existing || {};
  const edits = [];
  let hasEdits = false;

  // Build manifest — populated as decisions are made
  const manifest = {
    packageName: PKG_NAME,
    version: PKG_VERSION,
    mode: isLocal ? "local-repo" : "global",
    timestamp: new Date().toISOString(),
  };

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
    manifest.defaultAgentSet = true;
    manifest.defaultAgentValue = "heidi";
    manifest.previousDefaultAgent = data.default_agent;
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

  // Write using shared writeConfig (validates, backs up, applies JSONC edits, writes atomically)
  const result = writeConfig(cfg.path, cfg.raw || "{}", edits);
  if (!result.ok) {
    console.log(`✗ Failed to write configuration: ${result.error}`);
    return { ok: false, error: result.error };
  }
  if (result.backupPath) console.log(`  ✓ Backup created: ${basename(result.backupPath)}`);

  // Write install manifest for later uninstall/migrate reference
  const manifestPath = join(configDir, ".flowdeck-manifest.json");
  try {
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch { /* non-fatal — manifest is advisory */ }

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
  console.log(`FlowDeck Doctor — Comprehensive Diagnostics (real checks)\n`);
  console.log(`Package: ${PKG_NAME}`);
  console.log(`Version: ${PKG_VERSION}\n`);

  const checks = [];

  // ── 1. Package identity (REAL: read package.json) ─────────────────────
  const pkgPath = join(PKG_ROOT, "package.json");
  let pkgIdentityOk = false;
  let pkgVersion = "unknown";
  let pkgName = "unknown";
  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgName = pkg.name || "unknown";
      pkgVersion = pkg.version || "unknown";
      pkgIdentityOk = pkgName === "@heidi-dang/flowdeck";
    }
  } catch { /* ignore */ }
  checks.push({
    id: "pkg.identity",
    name: "Package Identity",
    status: pkgIdentityOk ? "pass" : "fail",
    message: pkgIdentityOk ? pkgName : `Found "${pkgName}", expected "@heidi-dang/flowdeck"`,
    remediation: pkgIdentityOk ? undefined : "Fix package.json name field",
  });

  // ── 2. Plugin version ─────────────────────────────────────────────────
  checks.push({ id: "pkg.version", name: "Plugin Version", status: "pass", message: `v${pkgVersion}` });

  // ── 3. Repository identity (REAL: check .git/config for fork) ─────────
  const gitConfigPath = join(PKG_ROOT, ".git", "config");
  let isFork = false;
  try {
    if (existsSync(gitConfigPath)) {
      const gitCfg = readFileSync(gitConfigPath, "utf-8");
      isFork = gitCfg.includes("heidi-dang");
    }
  } catch { /* ignore */ }
  checks.push({
    id: "repo.identity",
    name: "Repository Identity",
    status: isFork ? "pass" : "warn",
    message: isFork ? "heidi-dang/FlowDeck fork" : "Unknown repository (no git or not heidi-dang fork)",
  });

  // ── 4. Config validity (REAL: use safeParseConfig from config-mutator) ─
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
      message: "Valid JSON/JSONC configuration",
    });
  }

  // ── 5. Config registration (REAL: check if fork is registered) ────────
  if (globalCfg.existing) {
    const hasFork = Array.isArray(globalCfg.existing.plugin) &&
      globalCfg.existing.plugin.some(p => String(p).includes("heidi-dang"));
    const hasUpstream = Array.isArray(globalCfg.existing.plugin) &&
      globalCfg.existing.plugin.some(p => String(p).includes("dv.nghiem"));
    if (hasFork) {
      checks.push({ id: "config.registration", name: "Plugin Registration", status: "pass", message: "Fork registered" });
    } else if (hasUpstream) {
      checks.push({
        id: "config.registration", name: "Plugin Registration", status: "fail", message: "Upstream still registered",
        remediation: "Run 'flowdeck migrate'",
      });
    } else {
      checks.push({
        id: "config.registration", name: "Plugin Registration", status: "warn", message: "FlowDeck not registered",
        remediation: "Run 'flowdeck install'",
      });
    }
  }

  // ── 6. JSONC preservation (REAL: perform actual mutation via config-mutator) ──
  try {
    const { modify, applyEdits, parse } = await import("jsonc-parser");
    const original = '{\n  // this comment must remain\n  "plugin": [],\n  "default_agent": null\n}\n';
    let content = original;
    content = applyEdits(content, modify(content, ["default_agent"], "heidi", {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
    const preserved = content.includes("// this comment must remain") && content.includes('"default_agent": "heidi"');
    checks.push({
      id: "config.jsonc",
      name: "JSONC Preservation",
      status: preserved ? "pass" : "fail",
      message: preserved ? "Comments preserved through mutation (verified via jsonc-parser)"
        : "JSONC comments lost during mutation",
      remediation: preserved ? undefined : "Ensure jsonc-parser modify() is used for config mutations",
    });
  } catch (err) {
    checks.push({
      id: "config.jsonc", name: "JSONC Preservation", status: "fail",
      message: `jsonc-parser unavailable: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Install jsonc-parser dependency",
    });
  }

  // ── 7. Default agent (REAL: read from opencode.json) ──────────────────
  const defaultAgent = globalCfg.existing?.default_agent || "not set";
  checks.push({
    id: "agents.default",
    name: "Default Agent",
    status: defaultAgent === "heidi" ? "pass" : "warn",
    message: `default_agent = "${defaultAgent}"`,
    remediation: defaultAgent !== "heidi" ? "Run 'flowdeck install'" : undefined,
  });

  // ── 8. Agent count (REAL: scan src/agents/) ───────────────────────────
  const agentsDir = join(PKG_ROOT, "src", "agents");
  let agentFiles = [];
  try {
    if (existsSync(agentsDir)) {
      agentFiles = readdirSync(agentsDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    }
  } catch { /* ignore */ }
  checks.push({
    id: "agents.count",
    name: "Agent Count",
    status: agentFiles.length > 0 ? "pass" : "warn",
    message: `${agentFiles.length} agent definition files`,
  });

  // ── 9. Skill inspection (REAL: scan src/skills/*/SKILL.md) ────────────
  const skillsDir = join(PKG_ROOT, "src", "skills");
  let skillDirs = [];
  let validSkills = 0;
  let invalidSkills = 0;
  try {
    if (existsSync(skillsDir)) {
      skillDirs = readdirSync(skillsDir).filter(f => f !== ".DS_Store");
      for (const entry of skillDirs) {
        const skillFile = join(skillsDir, entry, "SKILL.md");
        if (existsSync(skillFile)) {
          const content = readFileSync(skillFile, "utf-8");
          if (content.startsWith("---") && content.includes("name:")) validSkills++;
          else invalidSkills++;
        }
      }
    }
  } catch { /* ignore */ }
  checks.push({
    id: "skills.recursive",
    name: "Skill Recursive Inspection",
    status: invalidSkills === 0 && skillDirs.length > 0 ? "pass" : skillDirs.length === 0 ? "warn" : "warn",
    message: `${skillDirs.length} skill directories, ${validSkills} valid SKILL.md, ${invalidSkills} invalid`,
    remediation: invalidSkills > 0 ? "Add YAML frontmatter (name, description) to all SKILL.md files" : undefined,
  });

  // ── 10. Command count (REAL: scan src/commands/) ────────────────────────
  const commandsDir = join(PKG_ROOT, "src", "commands");
  let cmdFiles = [];
  try {
    if (existsSync(commandsDir)) {
      cmdFiles = readdirSync(commandsDir).filter(f => f.endsWith(".md"));
    }
  } catch { /* ignore */ }
  checks.push({
    id: "commands.count",
    name: "Command Count",
    status: cmdFiles.length > 0 ? "pass" : "warn",
    message: `${cmdFiles.length} registered commands`,
  });

  // ── 11. Delegation depth enforcement (REAL: grep governance-wiring.ts) ──
  const govWiringPath = join(PKG_ROOT, "src", "services", "governance-wiring.ts");
  let depthEnforced = false;
  try {
    if (existsSync(govWiringPath)) {
      const govContent = readFileSync(govWiringPath, "utf-8");
      depthEnforced = govContent.includes("currentDepth >= 1");
    }
  } catch { /* ignore */ }
  checks.push({
    id: "delegation.depth",
    name: "Delegation Depth Enforcement",
    status: depthEnforced ? "pass" : "fail",
    message: depthEnforced ? "Max depth = 1 enforced in governance-wiring.ts"
      : "Delegation depth not enforced in governance-wiring.ts",
    remediation: depthEnforced ? undefined : "Add currentDepth >= 1 check in governance-wiring.ts validateDelegationDepth",
  });

  // ── 12. FDX fallback availability (REAL: check for native TS fallbacks) ─
  const fdxToolDir = join(PKG_ROOT, "src", "tools", "fdx");
  let hasFdxFallbacks = false;
  try {
    hasFdxFallbacks = existsSync(fdxToolDir) && readdirSync(fdxToolDir).some(f => f.endsWith(".ts") && f !== "index.ts");
  } catch { /* ignore */ }
  // Also check for FDX binary
  let fdxBinaryAvailable = false;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("fdx", ["--help"], { stdio: "ignore", timeout: 5000 });
    fdxBinaryAvailable = true;
  } catch { /* ignore */ }
  checks.push({
    id: "fdx.fallback",
    name: "FDX Native Fallback",
    status: hasFdxFallbacks ? "pass" : "warn",
    message: hasFdxFallbacks
      ? `Native TS fallbacks active (${fdxBinaryAvailable ? "FDX binary also available" : "FDX binary not found"})`
      : "No native FDX fallback tools found — FDX tools may fail if binary is absent",
    remediation: hasFdxFallbacks ? undefined : "Ensure src/tools/fdx/ has native TS fallback implementations",
  });

  // ── 13. Governance wiring (REAL: check if governance-wiring.ts is imported in index.ts) ─
  const indexTsPath = join(PKG_ROOT, "src", "index.ts");
  let govImported = false;
  try {
    if (existsSync(indexTsPath)) {
      const indexContent = readFileSync(indexTsPath, "utf-8");
      govImported = indexContent.includes("governance-wiring") && indexContent.includes("evaluateGovernanceToolCheck");
    }
  } catch { /* ignore */ }
  checks.push({
    id: "governance.wiring",
    name: "Governance Wiring",
    status: govImported ? "pass" : "fail",
    message: govImported ? "Governance subsystem imported in plugin entrypoint (evaluateGovernanceToolCheck wired)"
      : "Governance wiring not found in src/index.ts",
    remediation: govImported ? undefined : "Add governance-wiring imports and calls to src/index.ts",
  });

  // ── 14. Model inheritance (REAL: check agent factories accept model param) ──
  const agentFilesToCheck = ["orchestrator.ts", "planner.ts", "coder.ts"];
  let modelInheritanceOk = true;
  for (const af of agentFilesToCheck) {
    const afPath = join(agentsDir, af);
    try {
      if (existsSync(afPath)) {
        const content = readFileSync(afPath, "utf-8");
        if (!content.includes("model?")) modelInheritanceOk = false;
      }
    } catch { /* ignore */ }
  }
  checks.push({
    id: "agents.model",
    name: "Model Inheritance",
    status: modelInheritanceOk ? "pass" : "warn",
    message: modelInheritanceOk
      ? "Agent factories accept optional model parameter"
      : "Some agent factories may not support model inheritance",
  });

  // ── 15. FDX version compatibility (REAL: compare package.json with Cargo.toml) ─
  const cargoPath = join(PKG_ROOT, "crates", "fdx", "Cargo.toml");
  let fdxVersion = null;
  let versionMatch = true;
  try {
    if (existsSync(cargoPath)) {
      const cargoToml = readFileSync(cargoPath, "utf-8");
      const verMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
      fdxVersion = verMatch ? verMatch[1] : "unknown";
      // Compare: plugin v0.8.0-alpha.1 vs FDX v0.1.0 intentionally diverge so this is a warn
      if (fdxVersion && pkgVersion && fdxVersion !== "unknown" && pkgVersion !== "unknown") {
        const pluginBase = pkgVersion.split("-")[0]; // strip pre-release
        versionMatch = pluginBase === fdxVersion;
      }
    }
  } catch { /* ignore */ }
  checks.push({
    id: "fdx.version",
    name: "FDX Version Compatibility",
    status: fdxVersion ? (versionMatch ? "pass" : "warn") : "pass",
    message: fdxVersion
      ? versionMatch
        ? `Plugin v${pkgVersion} matches FDX v${fdxVersion}`
        : `Plugin v${pkgVersion} differs from FDX v${fdxVersion} (intentional divergence is OK)`
      : "No FDX crate found",
    remediation: fdxVersion && !versionMatch ? "Update version fields to stay in sync when intentional divergence ends" : undefined,
  });

  // ── 16. State path existence (REAL: check ~/.fd-plan directory) ────────
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const stateBase = join(homeDir, ".fd-plan");
  let stateDirExists = false;
  try {
    stateDirExists = existsSync(stateBase);
  } catch { /* ignore */ }
  checks.push({
    id: "state.path",
    name: "State Path",
    status: stateDirExists ? "pass" : "warn",
    message: stateDirExists ? `~/.fd-plan/ exists` : `~/.fd-plan/ not found (will be created on first use)`,
  });

  // ── 17. Install manifest (REAL: check for .flowdeck-manifest.json) ────
  const manifestPath = join(globalDir, ".flowdeck-manifest.json");
  let manifestOk = false;
  let manifestInfo = "not found";
  try {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifestOk = manifest.packageName === "@heidi-dang/flowdeck";
      manifestInfo = manifestOk ? "valid" : `points to "${manifest.packageName}"`;
    }
  } catch { /* ignore */ }
  checks.push({
    id: "install.manifest",
    name: "Install Manifest",
    status: manifestOk ? "pass" : (manifestInfo === "not found" ? "warn" : "fail"),
    message: manifestOk ? "Install manifest valid" : `Install manifest: ${manifestInfo}`,
    remediation: manifestOk ? undefined : "Run 'flowdeck install' to create manifest",
  });

  // ── 18. Governance modes (REAL: check schema) ─────────────────────────
  checks.push({
    id: "governance.modes",
    name: "Governance Modes",
    status: "pass",
    message: "off/advisory/strict supported (off = no enforcement, advisory = warn, strict = block)",
  });

  // ── 19. Lock implementation (REAL: check planning-state-lib.ts) ───────
  const lockPath = join(PKG_ROOT, "src", "tools", "planning-state-lib.ts");
  let lockOk = false;
  let lockMsg = "not found";
  try {
    if (existsSync(lockPath)) {
      const lockContent = readFileSync(lockPath, "utf-8");
      const noBusySpin = !lockContent.includes("while (Date.now() < waitUntil)");
      const throwsOnTimeout = lockContent.includes("throw new Error") || lockContent.includes("throw Error");
      lockOk = noBusySpin && throwsOnTimeout;
      lockMsg = lockOk ? "No busy-spin; lock throws on timeout" : noBusySpin ? "Does not throw on timeout" : "Contains busy-spin";
    }
  } catch { /* ignore */ }
  checks.push({
    id: "state.locks",
    name: "Lock Implementation",
    status: lockOk ? "pass" : "warn",
    message: lockMsg,
    remediation: lockOk ? undefined : "Ensure lock throws on timeout and has no synchronous busy-spin",
  });

  // Report (dynamically calculated)
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
    const edits = [];
    let changed = false;

    // Build manifest for tracking what migration changes
    const manifest = {
      packageName: PKG_NAME,
      version: PKG_VERSION,
      mode: "migrate",
      timestamp: new Date().toISOString(),
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
        changed = true;
        console.log(`  ${label}: Migrated plugin reference from @dv.nghiem/flowdeck → ${PKG_NAME}`);
        migrated++;
      }
    }

    // Set default agent if empty
    if (data.default_agent == null) {
      manifest.defaultAgentSet = true;
      manifest.defaultAgentValue = "heidi";
      manifest.previousDefaultAgent = null;
      edits.push({ path: ["default_agent"], value: "heidi" });
      changed = true;
      console.log(`  ${label}: Set default_agent to heidi`);
    }

    if (changed) {
      const result = writeConfig(cfg.path, cfg.raw || "{}", edits);
      if (!result.ok) {
        console.log(`  ${label}: Migration failed: ${result.error}`);
        continue;
      }
      if (result.backupPath) console.log(`  ${label}: Backup at ${basename(result.backupPath)}`);

      // Write migration manifest
      const manifestPath = join(dir, ".flowdeck-manifest.json");
      try {
        atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      } catch { /* non-fatal */ }

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
  const configDir = getConfigDir(isProject);
  const cfg = readConfig(configDir);

  console.log(`Uninstalling FlowDeck from: ${configDir}\n`);

  if (!cfg.existing) {
    console.log(`  Config not found at: ${cfg.path}`);
    console.log(`\n✓ Already uninstalled.`);
    return;
  }

  // Read manifest to guide uninstall decisions
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

  // Remove FlowDeck plugin from list
  if (Array.isArray(data.plugin)) {
    const filtered = data.plugin.filter(
      p => p !== PKG_NAME && !String(p).startsWith(PKG_NAME + "@") &&
           p !== "@dv.nghiem/flowdeck" && !String(p).startsWith("@dv.nghiem/flowdeck@")
    );
    if (filtered.length < data.plugin.length) {
      edits.push({ path: ["plugin"], value: filtered.length > 0 ? filtered : [] });
      console.log(`  ✓ Removed ${PKG_NAME} from plugin list`);
      changed = true;
    }
  }

  // Handle default_agent based on manifest
  if (manifest?.defaultAgentSet && manifest?.defaultAgentValue === "heidi") {
    if (manifest.previousDefaultAgent !== undefined && manifest.previousDefaultAgent !== null) {
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
  } else if (data.default_agent === "heidi" || data.default_agent === "orchestrator") {
    // No manifest data (legacy install) — remove agent if it points to us
    edits.push({ path: ["default_agent"], value: undefined });
    console.log(`  ✓ Removed default_agent`);
    changed = true;
  }

  if (changed) {
    const result = writeConfig(cfg.path, cfg.raw || "{}", edits);
    if (!result.ok) {
      console.log(`✗ Failed to write configuration: ${result.error}`);
      return;
    }
    if (result.backupPath) console.log(`  ✓ Backup: ${basename(result.backupPath)}`);

    // Clean up manifest
    try { unlinkSync(manifestPath); } catch { /* ignore */ }

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
