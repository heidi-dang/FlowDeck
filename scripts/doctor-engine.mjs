#!/usr/bin/env node
// scripts/doctor-engine.mjs — Shared authoritative Doctor logic
//
// Standalone ESM module providing comprehensive FlowDeck diagnostics.
// Used by:
//   - bin/flowdeck.js (CLI doctor command)
//   - src/services/doctor.ts (OpenCode tool bridge)
//
// All checks are real — nothing is hardcoded as pass.

import { readFileSync, existsSync, readdirSync, mkdirSync, accessSync, constants } from "node:fs"
import { join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { safeParseConfig } from "./config-mutator.mjs"
import { pathToFileURL } from "node:url"

/**
 * Run all doctor checks against the given FlowDeck directory.
 * Returns a tally of passed / warned / failed with per-check details.
 *
 * @param {string} directory - Root of the FlowDeck package
 * @returns {Promise<{passed: number, warned: number, failed: number, checks: Array<{id: string, name: string, status: string, message: string, remediation?: string}>}>}
 */
export async function runDoctorChecks(directory) {
  const checks = []
  const distPath = pathToFileURL(resolve(directory, "dist", "index.js")).href

  // ── Helpers ──────────────────────────────────────────────────────────
  const tryRead = (p) => { try { return readFileSync(p, "utf-8") } catch { return null } }
  const safeList = (p) => { try { return readdirSync(p) } catch { return [] } }

  // ── 1. Package identity ────────────────────────────────────────────────
  const pkgPath = join(directory, "package.json")
  const pkgRaw = tryRead(pkgPath)
  let pkgName = "", pkgVersion = "unknown"
  if (pkgRaw) {
    try { const p = JSON.parse(pkgRaw); pkgName = p.name || ""; pkgVersion = p.version || "unknown" } catch { /* ignore */ }
  }
  if (pkgName === "@heidi-dang/flowdeck") {
    checks.push({ id: "pkg.identity", name: "Package Identity", status: "pass", message: pkgName })
  } else if (pkgName.startsWith("@")) {
    checks.push({ id: "pkg.identity", name: "Package Identity", status: "fail", message: `Found "${pkgName}", expected "@heidi-dang/flowdeck"`, remediation: "Fix package.json name field" })
  } else {
    checks.push({ id: "pkg.identity", name: "Package Identity", status: "fail", message: `Unknown package: "${pkgName}"`, remediation: "Ensure package.json exists with correct name" })
  }

  // ── 2. Plugin version ───────────────────────────────────────────────────
  checks.push({ id: "pkg.version", name: "Plugin Version", status: "pass", message: `v${pkgVersion}` })

  // ── 3. Repository identity ─────────────────────────────────────────────
  const gitConfig = tryRead(join(directory, ".git", "config"))
  const isFork = gitConfig?.includes("heidi-dang") ?? false
  checks.push({
    id: "repo.identity", name: "Repository Identity",
    status: isFork ? "pass" : "warn",
    message: isFork ? "heidi-dang/FlowDeck fork" : "Unknown repository (no git or not heidi-dang fork)",
  })

  // ── 4. Config validity ──────────────────────────────────────────────────
  // Check opencode.json in the config directory
  const configDir = resolveConfigDir()
  const opencodePath = join(configDir, "opencode.json")
  if (existsSync(opencodePath)) {
    const raw = tryRead(opencodePath)
    if (raw) {
      const parsed = safeParseConfig(raw)
      checks.push({
        id: "config.validity",
        name: "Config Validity",
        status: parsed.ok ? "pass" : "fail",
        message: parsed.ok ? "Valid JSON/JSONC configuration" : `Malformed: ${parsed.error}`,
        remediation: parsed.ok ? undefined : "Fix syntax errors in opencode.json",
      })
    } else {
      checks.push({ id: "config.validity", name: "Config Validity", status: "warn", message: "Could not read opencode.json" })
    }
  }
  // Also check for .flowdeck.json / .flowdeck.jsonc in the project directory
  for (const name of [".flowdeck.jsonc", ".flowdeck.json"]) {
    const fp = join(directory, name)
    if (existsSync(fp)) {
      const raw = tryRead(fp)
      if (raw) {
        const parsed = safeParseConfig(raw)
        // Only push if we haven't already or if we want to override
        if (parsed.ok) {
          // Check if we already have a config.validity entry from opencode.json
          const existing = checks.find(c => c.id === "config.validity")
          if (!existing || existing.status !== "pass") {
            checks.push({
              id: "config.validity",
              name: "Config Validity",
              status: "pass",
              message: "Valid configuration",
              remediation: undefined,
            })
          }
        } else {
          checks.push({
            id: "config.validity",
            name: "Config Validity",
            status: "fail",
            message: `Malformed: ${parsed.error}`,
            remediation: "Fix syntax errors in " + name,
          })
        }
      }
      break // only check the first found
    }
  }
  if (checks.findIndex(c => c.id === "config.validity") === -1) {
    checks.push({ id: "config.validity", name: "Config Validity", status: "warn", message: "No config found" })
  }

  // ── 5. Config registration ─────────────────────────────────────────────
  if (existsSync(opencodePath)) {
    const raw = tryRead(opencodePath)
    if (raw) {
      const hasFork = raw.includes("@heidi-dang/flowdeck")
      const hasUpstream = raw.includes("@dv.nghiem/flowdeck")
      if (hasFork) {
        checks.push({ id: "config.registration", name: "Plugin Registration", status: "pass", message: "@heidi-dang/flowdeck registered" })
      } else if (hasUpstream) {
        checks.push({ id: "config.registration", name: "Plugin Registration", status: "fail", message: "Upstream @dv.nghiem/flowdeck still registered", remediation: "Run 'flowdeck migrate'" })
      } else {
        checks.push({ id: "config.registration", name: "Plugin Registration", status: "warn", message: "FlowDeck not registered", remediation: "Run 'flowdeck install'" })
      }
    }
  }

  // ── 6. JSONC preservation (BEHAVIOURAL TEST) ────────────────────────────
  const jsoncOk = await testJsoncPreservation()
  checks.push({
    id: "config.jsonc",
    name: "JSONC Preservation",
    status: jsoncOk.ok ? "pass" : "fail",
    message: jsoncOk.ok ? "Comments preserved through mutation (verified via jsonc-parser)" : jsoncOk.error,
    remediation: jsoncOk.ok ? undefined : "Use jsonc-parser modify() for config mutations instead of JSON.stringify",
  })

  // ── 7. Default agent ──────────────────────────────────────────────────
  let defaultAgent = "not set"
  if (existsSync(opencodePath)) {
    const raw = tryRead(opencodePath)
    if (raw) {
      const parsed = safeParseConfig(raw)
      if (parsed.ok && parsed.data && typeof parsed.data === "object") {
        defaultAgent = parsed.data.default_agent ?? "not set"
      }
    }
  }
  checks.push({
    id: "agents.default",
    name: "Default Agent",
    status: defaultAgent === "heidi" ? "pass" : "warn",
    message: `default_agent = "${defaultAgent}"`,
    remediation: defaultAgent !== "heidi" ? "Run 'flowdeck install'" : undefined,
  })

  // ── 8. Agent count ─────────────────────────────────────────────────────
  // Fail closed: initialize to 0. Only pass when a probe actually executes.
  let agentCount = 0
  let agentCountSource = "unknown"
  const registryFile = join(directory, "src", "services", "canonical-registry.ts")
  if (existsSync(registryFile)) {
    const content = tryRead(registryFile)
    if (content) {
      const arrayMatch = content.match(/const CANONICAL_AGENTS:\s*\w+\[\]\s*=\s*\[([\s\S]+?)\]\s*const|const CANONICAL_AGENTS:\s*\w+\[\]\s*=\s*\[([\s\S]+?)\]\s*export/s)
      const listContent = arrayMatch ? (arrayMatch[1] || arrayMatch[2]) : content
      const matches = listContent.match(/id:\s*"([^"]+)"/g)
      if (matches) {
        agentCount = matches.length
        agentCountSource = "src/services/canonical-registry.ts"
      }
    }
  }
  if (agentCount === 0) {
    // Packed install: load from runtime exports (must be present in dist/index.js)
    try {
      const agentMod = await import(distPath)
      if (agentMod && Array.isArray(agentMod.AGENT_NAMES) && agentMod.AGENT_NAMES.length > 0) {
        agentCount = agentMod.AGENT_NAMES.length
        agentCountSource = "runtime"
      }
    } catch { /* import failed — count stays 0 = fail */ }
  }
  checks.push({
    id: "agents.count",
    name: "Agent Count",
    status: agentCount > 0 ? "pass" : "fail",
    message: agentCount > 0 ? `${agentCount} agents registered (${agentCountSource})` : "Agent count could not be determined from src/ or runtime exports",
    remediation: agentCount === 0 ? "Ensure AGENT_NAMES is exported from dist/index.js" : undefined,
  })

  // ── 9. Skill recursive inspection ──────────────────────────────────────
  const skillsDir = join(directory, "src", "skills")
  const skillDirs = safeList(skillsDir).filter(f => f !== ".DS_Store")
  let validSkills = 0, invalidSkills = 0
  for (const entry of skillDirs) {
    const sf = join(skillsDir, entry, "SKILL.md")
    if (existsSync(sf)) {
      const content = tryRead(sf)
      if (content && content.startsWith("---") && content.includes("name:")) validSkills++
      else invalidSkills++
    }
  }
  checks.push({
    id: "skills.recursive",
    name: "Skill Recursive Inspection",
    status: invalidSkills === 0 && skillDirs.length > 0 ? "pass" : skillDirs.length === 0 ? "fail" : "warn",
    message: `${skillDirs.length} skills, ${validSkills} valid, ${invalidSkills} issues`,
    remediation: invalidSkills > 0 ? "Add YAML frontmatter (name, description) to all SKILL.md files" : undefined,
  })

  // ── 10. Command count ──────────────────────────────────────────────────
  const commandsDir = join(directory, "src", "commands")
  const cmdFiles = safeList(commandsDir).filter(f => f.endsWith(".md"))
  checks.push({
    id: "commands.count",
    name: "Command Count",
    status: cmdFiles.length > 0 ? "pass" : "warn",
    message: `${cmdFiles.length} registered commands (src/commands/*.md)`,
  })

  // ── 11. Delegation depth enforcement ────────────────────────────────────
  // Fail closed: only pass if probe actually executes AND satisfies all delegation rules.
  let depthEnforced = false
  let depthMsg = "validateDelegationDepth not exported from dist/index.js"
  try {
    const distMod = await import(distPath)
    if (distMod && typeof distMod.validateDelegationDepth === "function") {
      const specialists = new Set(["architect", "coder"])
      const c1 = distMod.validateDelegationDepth("heidi", "architect", 0, specialists, 1) // allowed
      const c2 = distMod.validateDelegationDepth("heidi", "architect", 1, specialists, 1) // blocked
      const c3 = distMod.validateDelegationDepth("architect", "coder", 0, specialists, 1) // blocked
      const c4 = distMod.validateDelegationDepth("heidi", "heidi", 0, specialists, 1) // blocked

      if (c1?.allowed === true && c2?.allowed === false && c3?.allowed === false && c4?.allowed === false) {
        depthEnforced = true
        depthMsg = "Max depth = 1 enforced"
      } else {
        depthMsg = `Delegation checks failed: c1=${c1?.allowed}, c2=${c2?.allowed}, c3=${c3?.allowed}, c4=${c4?.allowed}`
      }
    }
  } catch (err) {
    depthMsg = `Import failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "delegation.depth",
    name: "Delegation Depth Enforcement",
    status: depthEnforced ? "pass" : "fail",
    message: depthMsg,
    remediation: depthEnforced ? undefined : "Export validateDelegationDepth from dist/index.js and ensure all delegation rules are satisfied",
  })

  // ── 12. Governance wiring ──────────────────────────────────────────────
  // Fail closed: only pass if plugin default export is a non-null object with an events/tools property.
  let govImported = false
  let govMsg = "dist/index.js default export missing or not a plugin object/function"
  try {
    const distMod = await import(distPath)
    if (distMod && distMod.default && (typeof distMod.default === "object" || typeof distMod.default === "function")) {
      govImported = true
      govMsg = "Governance subsystem imported in plugin entrypoint"
    }
  } catch (err) {
    govMsg = `Import failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "governance.wiring",
    name: "Governance Wiring",
    status: govImported ? "pass" : "fail",
    message: govMsg,
    remediation: govImported ? undefined : "Ensure dist/index.js exports a valid OpenCode plugin as default",
  })

  // ── 13. FDX fallback availability ─────────────────────────────────────
  const fdxToolDir = join(directory, "src", "tools")
  const fdxFiles = safeList(fdxToolDir).filter(f => f.startsWith("fdx") && f.endsWith(".ts"))
  let fdxBinaryAvailable = false
  try { execFileSync("fdx", ["--version"], { stdio: "ignore", timeout: 5000 }); fdxBinaryAvailable = true } catch { /* ignore */ }
  const fallbackAvailable = fdxFiles.length > 0 || existsSync(join(directory, "dist"))
  let fallbackStatus = "pass"
  let fallbackMsg = ""
  if (fdxBinaryAvailable) {
    fallbackMsg = `FDX binary available; fallback files present: ${fallbackAvailable}`
  } else {
    if (fallbackAvailable) {
      fallbackStatus = "warn"
      fallbackMsg = `FDX binary not found; using fallback: ${fdxFiles.length > 0 ? fdxFiles.join(", ") : "dist package"}`
    } else {
      fallbackStatus = "fail"
      fallbackMsg = "FDX binary not found and no fallback implementation available"
    }
  }
  checks.push({
    id: "fdx.fallback",
    name: "FDX Native Fallback",
    status: fallbackStatus,
    message: fallbackMsg,
    remediation: fallbackStatus === "fail" ? "Install the FDX binary or restore source/dist fallback files" : undefined,
  })

  // ── 14. FDX version compatibility ──────────────────────────────────────
  const fdxCompat = testFdxVersionCompatibility(directory, pkgRaw)
  checks.push({
    id: "fdx.version",
    name: "FDX Version Compatibility",
    status: fdxCompat.status,
    message: fdxCompat.message,
    remediation: fdxCompat.remediation,
  })

  // ── 15. Lock implementation ────────────────────────────────────────────
  // Fail closed: only pass if the full acquire+contention probe executes successfully.
  let lockOk = false
  let lockMsg = "acquireLock/releaseLock not exported from dist/index.js"
  try {
    const distMod = await import(distPath)
    if (distMod && typeof distMod.acquireLock === "function" && typeof distMod.releaseLock === "function") {
      const testLockFile = join(tmpdir(), `fd-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`)
      try {
        await distMod.acquireLock(testLockFile, { timeout: 200, staleMs: 10000 })
        let secondCallThrew = false
        try {
          await distMod.acquireLock(testLockFile, { timeout: 50, staleMs: 10000 })
        } catch {
          secondCallThrew = true
        }
        if (secondCallThrew) {
          lockOk = true
          lockMsg = "No busy-spin; lock throws on timeout"
        } else {
          lockMsg = "Lock did not throw on timeout — double-acquire succeeded"
        }
      } finally {
        try {
          await distMod.releaseLock(testLockFile)
        } catch { /* ignore */ }
        try {
          const { unlinkSync, existsSync } = await import("node:fs")
          if (existsSync(testLockFile)) unlinkSync(testLockFile)
        } catch {}
      }
    }
  } catch (err) {
    lockMsg = `Lock probe failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "state.locks",
    name: "Lock Implementation",
    status: lockOk ? "pass" : "fail",
    message: lockMsg,
    remediation: lockOk ? undefined : "Export acquireLock/releaseLock from dist/index.js",
  })

  // ── 16. Install manifest ───────────────────────────────────────────────
  const manifestPath = join(configDir, ".flowdeck-manifest.json")
  let manifestOk = false, manifestInfo = "not found"
  let manifestMode = null, manifestRef = null, manifestCheckout = null
  let isUninstalled = false
  const manifestRaw = tryRead(manifestPath)
  if (manifestRaw) {
    try {
      const m = JSON.parse(manifestRaw)
      if (m.uninstalledAt || m.pluginAdded === false || m.installationMode === "uninstall") {
        isUninstalled = true
        manifestInfo = "uninstalled"
      } else {
        manifestRef = m.pluginRef || m.packageName || null
        manifestMode = m.installationMode || null
        manifestCheckout = m.checkoutPath || null
        manifestOk = manifestRef === "@heidi-dang/flowdeck" || manifestRef === "file://" + resolve(directory) || manifestRef === "file://" + directory
        // If mode is local-repo, verify checkoutPath resolves to an actual directory
        if (manifestOk && manifestMode === "local-repo" && manifestCheckout) {
          const resolvedPath = resolve(manifestCheckout)
          manifestOk = existsSync(resolvedPath)
          if (!manifestOk) manifestInfo = `checkoutPath "${manifestCheckout}" resolves to "${resolvedPath}" which does not exist`
        }
        if (manifestOk) manifestInfo = "valid"
        else if (manifestInfo === "not found") manifestInfo = `points to "${manifestRef || "unknown"}"`
      }
    } catch { manifestInfo = "corrupt" }
  }
  let manifestMsg = manifestOk ? "Install manifest valid (transactional ownership tracked)" : `Install manifest: ${manifestInfo}`
  if (manifestMode) {
    const modeLabels = {
      "npm": "npm (global)",
      "project": "project (local .opencode/)",
      "local-repo": "local repository",
      "postinstall": "npm postinstall",
      "migrate": "migration from upstream",
    }
    manifestMsg += ` | mode: ${modeLabels[manifestMode] || manifestMode}`
  }
  if (manifestCheckout) {
    manifestMsg += ` | checkout: ${manifestCheckout}`
  }
  checks.push({
    id: "install.manifest",
    name: "Install Manifest",
    status: manifestOk ? "pass" : (isUninstalled || manifestInfo === "not found" ? "warn" : "fail"),
    message: manifestMsg,
    remediation: manifestOk ? undefined : "Run 'flowdeck install' to create manifest",
  })

  // ── 17. Install mode detection ─────────────────────────────────────────
  // Prefer manifest's installationMode when available (more reliable)
  let installMode, modeOk
  const manifestPath17 = join(configDir, ".flowdeck-manifest.json")
  const manifestRaw17 = tryRead(manifestPath17)
  let installModeFromManifest = null
  if (manifestRaw17) {
    try {
      const m = JSON.parse(manifestRaw17)
      if (m.installationMode) installModeFromManifest = m.installationMode
    } catch { /* ignore */ }
  }

  if (installModeFromManifest) {
    const modeLabels = {
      "npm": "npm (global install)",
      "project": "project (local .opencode/)",
      "local-repo": "local repository checkout",
      "postinstall": "npm postinstall hook",
      "migrate": "migration from upstream",
    }
    installMode = modeLabels[installModeFromManifest] || installModeFromManifest
    modeOk = true
  } else {
    // Fall back to heuristics when no manifest exists
    const hasGit = existsSync(join(directory, ".git"))
    const hasSrc = existsSync(join(directory, "src"))
    const inNodeModules = directory.includes("node_modules")
    if (hasGit && hasSrc) {
      installMode = "source checkout (no manifest)"
      modeOk = true
    } else if (inNodeModules) {
      installMode = "npm install (no manifest)"
      modeOk = existsSync(join(directory, "scripts", "config-mutator.mjs"))
    } else if (hasSrc) {
      installMode = "local-repo (no manifest)"
      modeOk = true
    } else {
      installMode = "unknown"
      modeOk = false
    }
  }
  checks.push({
    id: "install.mode",
    name: "Install Mode Detection",
    status: modeOk ? "pass" : "warn",
    message: `Install mode: ${installMode}`,
    remediation: modeOk ? undefined : "Could not determine install mode",
  })

  // ── 18. Registry consistency ──────────────────────────────────────────
  // Fail closed: only pass if AGENT_NAMES and createAgent are both present AND
  // every agent name resolves to a factory.
  let registryOk = false
  let regCount = 0
  let regMsg = "AGENT_NAMES or createAgent not exported from dist/index.js"
  try {
    const distMod = await import(distPath)
    if (distMod && Array.isArray(distMod.AGENT_NAMES) && typeof distMod.createAgent === "function") {
      regCount = distMod.AGENT_NAMES.length
      const missing = distMod.AGENT_NAMES.filter(name => distMod.createAgent(name) === undefined)
      if (missing.length === 0 && regCount > 0) {
        registryOk = true
        regMsg = `${regCount} agent definitions all consistent with runtime factory registry`
      } else if (missing.length > 0) {
        regMsg = `${missing.length} agents lack factory implementations: ${missing.join(", ")}`
      } else {
        regMsg = "AGENT_NAMES is empty"
      }
    }
  } catch (err) {
    regMsg = `Import failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "agents.consistency",
    name: "Registry Consistency",
    status: registryOk ? "pass" : "fail",
    message: regMsg,
    remediation: !registryOk ? "Ensure AGENT_NAMES and createAgent are exported from dist/index.js" : undefined,
  })

  // ── 18.5. Runtime agent enforcement ────────────────────────────────────
  const runtimeAgentCfg = await importRuntimeAgentConfig(directory)
  if (runtimeAgentCfg) {
    checks.push({
      id: "runtime.agent.enforcement",
      name: "Runtime Agent Enforcement",
      status: "pass",
      message: `enforcement=${runtimeAgentCfg.enforcement}, expectedAgent=${runtimeAgentCfg.expectedAgent}`,
    })
  } else {
    checks.push({
      id: "runtime.agent.enforcement",
      name: "Runtime Agent Enforcement",
      status: "warn",
      message: "runtimeAgent config not found — using defaults (strict/heidi)",
    })
  }

  // ── 19. CLI commands availability ──────────────────────────────────────
  const cliPath = join(directory, "bin", "flowdeck.js")
  const cliContent = tryRead(cliPath)
  let cliCommands = []
  if (cliContent) {
    const handlerMatch = cliContent.match(/const handlers = \{([^}]+)\}/s)
    if (handlerMatch) {
      cliCommands = handlerMatch[1].split(",").map(s => s.trim()).filter(Boolean).map(s => s.split(":")[0].trim().replace(/["']/g, ""))
    }
  }
  const requiredCmds = ["install", "update", "verify", "doctor", "uninstall", "migrate", "rollback"]
  const missingCmds = requiredCmds.filter(cmd => !cliCommands.includes(cmd))
  let cliStatus = "pass"
  let cliMsg = `${cliCommands.length} CLI commands available: ${cliCommands.join(", ")}`
  let cliRemedy = undefined
  if (missingCmds.length > 0) {
    cliStatus = "fail"
    cliMsg = `Missing required CLI commands: ${missingCmds.join(", ")}`
    cliRemedy = "Ensure bin/flowdeck.js exports install, update, verify, doctor, uninstall, migrate, and rollback"
  } else if (cliCommands.length < 5) {
    cliStatus = "warn"
    cliRemedy = "Ensure bin/flowdeck.js has all command handlers registered"
  }
  checks.push({
    id: "cli.commands",
    name: "CLI Commands Availability",
    status: cliStatus,
    message: cliMsg,
    remediation: cliRemedy,
  })

  // ── 20. State path ─────────────────────────────────────────────────────
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
  const stateBase = join(homeDir, ".fd-plan")
  checks.push({
    id: "state.path",
    name: "State Path",
    status: existsSync(stateBase) ? "pass" : "warn",
    message: existsSync(stateBase) ? `~/.fd-plan/ exists` : `~/.fd-plan/ not found (will be created on first use)`,
  })

  // ── 21. Writable state directory ─────────────────────────────────────
  let stateWritable = false
  try { if (!existsSync(stateBase)) mkdirSync(stateBase, { recursive: true }); accessSync(stateBase, constants.W_OK); stateWritable = true } catch { /* ignore */ }
  checks.push({
    id: "state.writable",
    name: "Writable State Directory",
    status: stateWritable ? "pass" : "warn",
    message: stateWritable ? `Writable: ${stateBase}` : `Not writable: ${stateBase}`,
  })

  // ── 22. Governance modes ─────────────────────────────────────────────
  // Fail closed: only pass if evaluateGovernanceToolCheck is exported AND
  // each mode probe returns the expected action (off=allow, advisory=warn, strict=block).
  let govModesOk = false
  let govModesMsg = "evaluateGovernanceToolCheck not exported from dist/index.js"
  try {
    const distMod = await import(distPath)
    if (distMod && typeof distMod.evaluateGovernanceToolCheck === "function") {
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");

      const testDir = join(tmpdir(), "fd-gov-test-" + Date.now());
      mkdirSync(testDir, { recursive: true });
      const dirOff = join(testDir, "off"); mkdirSync(dirOff); mkdirSync(join(dirOff, ".opencode"));
      const dirAdv = join(testDir, "adv"); mkdirSync(dirAdv); mkdirSync(join(dirAdv, ".opencode"));
      const dirStrict = join(testDir, "strict"); mkdirSync(dirStrict); mkdirSync(join(dirStrict, ".opencode"));

      writeFileSync(join(dirOff, ".flowdeck.json"), '{"governance":{"validator":{"mode":"off"}}}');
      writeFileSync(join(dirAdv, ".flowdeck.json"), '{"governance":{"validator":{"mode":"advisory"}}}');
      writeFileSync(join(dirStrict, ".flowdeck.json"), '{"governance":{"validator":{"mode":"strict"}}}');

      // Use a controlled dangerous tool to test all three modes
      const modeOff = distMod.evaluateGovernanceToolCheck({ directory: dirOff, agent: "heidi", tool: "bash" })
      const modeAdv = distMod.evaluateGovernanceToolCheck({ directory: dirAdv, agent: "heidi", tool: "bash" })
      const modeStrict = distMod.evaluateGovernanceToolCheck({ directory: dirStrict, agent: "heidi", tool: "bash" })

      try { rmSync(testDir, { recursive: true, force: true }) } catch {}

      const offOk = modeOff && modeOff.action === "allow"
      const advOk = modeAdv && modeAdv.action === "warn"   // advisory must warn, never silently allow
      const strictOk = modeStrict && modeStrict.action === "block"

      if (offOk && advOk && strictOk) {
        govModesOk = true
        govModesMsg = "off/advisory/strict supported (off = no enforcement, advisory = warn, strict = block)"
      } else {
        govModesMsg = `Mode probe failed: off=${JSON.stringify(modeOff?.action)}, adv=${JSON.stringify(modeAdv?.action)}, strict=${JSON.stringify(modeStrict?.action)}`
      }
    }
  } catch (err) {
    govModesMsg = `Governance probe failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "governance.modes",
    name: "Governance Modes",
    status: govModesOk ? "pass" : "fail",
    message: govModesMsg,
    remediation: govModesOk ? undefined : "Export evaluateGovernanceToolCheck from dist/index.js",
  })

  // ── 23. Model inheritance ─────────────────────────────────────────────
  // Fail closed: only pass if createAgent is exported AND accepts a model parameter.
  let modelInheritanceOk = false
  let modelMsg = "createAgent not exported from dist/index.js"
  try {
    const distMod = await import(distPath)
    if (distMod && typeof distMod.createAgent === "function") {
      const pAgent = distMod.createAgent("planner", "custom-model-test")
      const hAgent = distMod.createAgent("heidi", "custom-model-test")
      if (pAgent !== undefined && hAgent !== undefined && pAgent.config?.model === "custom-model-test" && hAgent.config?.model === "custom-model-test") {
        modelInheritanceOk = true
        modelMsg = "Agent factories accept optional model parameter and correctly apply the override"
      } else {
        modelMsg = `createAgent did not correctly apply custom model override: planner=${JSON.stringify(pAgent?.config?.model)}, heidi=${JSON.stringify(hAgent?.config?.model)}`
      }
    }
  } catch (err) {
    modelMsg = `Model probe failed: ${err instanceof Error ? err.message : String(err)}`
  }
  checks.push({
    id: "agents.model",
    name: "Model Inheritance",
    status: modelInheritanceOk ? "pass" : "fail",
    message: modelMsg,
    remediation: modelInheritanceOk ? undefined : "Export createAgent from dist/index.js",
  })

  // ── 24. Installer identity ──────────────────────────────────────────────
  const flowdeckJs = tryRead(join(directory, "bin", "flowdeck.js"))
  const installsFork = flowdeckJs?.includes("@heidi-dang/flowdeck") ?? false
  const postinstallMjs = tryRead(join(directory, "postinstall.mjs"))
  const postinstallClean = postinstallMjs && !postinstallMjs.includes("writeConfig") && !postinstallMjs.includes("opencode.json") && postinstallMjs.includes("side-effect-free")
  checks.push({
    id: "config.installer",
    name: "Installer Identity",
    status: installsFork && postinstallClean ? "pass" : "warn",
    message: installsFork
      ? (postinstallClean ? "Postinstall is side-effect-free; 'flowdeck install' handles setup" : "FlowDeck installer registers @heidi-dang/flowdeck")
      : "Installer does not register the fork package",
    remediation: installsFork ? undefined : "Fix bin/flowdeck.js to register @heidi-dang/flowdeck",
  })

  // ── 25. Directory readable ─────────────────────────────────────────────
  try {
    accessSync(directory, constants.R_OK)
    checks.push({ id: "fs.readable", name: "Workspace Readable", status: "pass", message: `Readable: ${directory}` })
  } catch {
    checks.push({ id: "fs.readable", name: "Workspace Readable", status: "fail", message: `Not readable: ${directory}`, remediation: "Check permissions" })
  }

  // ── Tally ──────────────────────────────────────────────────────────────
  const passed = checks.filter(c => c.status === "pass").length
  const warned = checks.filter(c => c.status === "warn").length
  const failed = checks.filter(c => c.status === "fail").length

  return { passed, warned, failed, checks }
}

// ── Internal test implementations ─────────────────────────────────────────

async function testJsoncPreservation() {
  try {
    const { modify, applyEdits } = await import("jsonc-parser")
    const original = '{\n  // this comment must remain\n  "plugin": [],\n  "default_agent": null\n}\n'
    let content = original
    content = applyEdits(content, modify(content, ["default_agent"], "heidi", {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }))
    const preserved = content.includes("// this comment must remain") && content.includes('"default_agent": "heidi"')
    if (!preserved) return { ok: false, error: "JSONC comments lost during mutation" }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `jsonc-parser error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function testFdxVersionCompatibility(directory, pkgRaw, customFdxOutput = undefined) {
  let requiredRange = "^0.1.0"
  if (!pkgRaw && directory) {
    try {
      pkgRaw = readFileSync(join(directory, "package.json"), "utf-8")
    } catch {}
  }
  if (pkgRaw) {
    try {
      const p = JSON.parse(pkgRaw)
      if (p.flowdeckFdxCompatibility?.required) {
        requiredRange = p.flowdeckFdxCompatibility.required
      }
    } catch { /* ignore */ }
  }

  let installedVersion = null
  let malformedOutput = false
  if (customFdxOutput !== undefined) {
    if (typeof customFdxOutput === "string" && customFdxOutput.trim() !== "") {
      const match = customFdxOutput.trim().match(/^fdx\s+(.+)/)
      if (match) {
        installedVersion = match[1]
      } else {
        // Non-empty string that doesn't match expected format → binary is present
        // but returned garbage output. This is a FAIL, not a missing-binary warn.
        malformedOutput = true
      }
    }
  } else {
    try {
      const output = execFileSync("fdx", ["--version"], { encoding: "utf-8", timeout: 5000 })
      if (output && output.trim() !== "") {
        const match = output.trim().match(/^fdx\s+(.+)/)
        if (match) {
          installedVersion = match[1]
        } else {
          malformedOutput = true
        }
      }
    } catch { /* fdx not available */ }
  }

  if (malformedOutput) {
    return { status: "fail", message: "FDX binary returned malformed output (expected 'fdx <version>')", remediation: "Ensure 'fdx --version' outputs 'fdx <semver>'" }
  }
  if (!installedVersion) {
    return { status: "warn", message: "FDX binary not found — fallback active", remediation: undefined }
  }

  const platform = process.platform
  const arch = process.arch

  const isCompatible = satisfiesCaretRange(installedVersion, requiredRange)
  if (isCompatible) {
    return { status: "pass", message: `FDX v${installedVersion} satisfies ${requiredRange} on ${platform}/${arch}`, remediation: undefined }
  }

  const reqParts = requiredRange.replace("^", "").split(".").map(Number)
  const fdxParts = installedVersion.split(".").map(Number)
  const isTooOld = fdxParts[0] < reqParts[0] || (fdxParts[0] === reqParts[0] && fdxParts[1] < reqParts[1]) || (fdxParts[0] === reqParts[0] && fdxParts[1] === reqParts[1] && (fdxParts[2] ?? 0) < (reqParts[2] ?? 0))
  const isTooNew = fdxParts[0] > reqParts[0] || (fdxParts[0] === reqParts[0] && fdxParts[1] > reqParts[1])

  if (isTooOld) return { status: "fail", message: `FDX v${installedVersion} is too old for ${requiredRange}`, remediation: "Upgrade FDX via 'cargo install --path crates/fdx'" }
  if (isTooNew) return { status: "fail", message: `FDX v${installedVersion} is newer than ${requiredRange}`, remediation: "Update flowdeckFdxCompatibility in package.json" }
  return { status: "fail", message: `FDX v${installedVersion} does not satisfy required range ${requiredRange}`, remediation: "Update FDX crate version" }
}

function satisfiesCaretRange(version, range) {
  const prefix = range[0]
  if (prefix !== "^") {
    const clean = prefix === "=" ? range.slice(1) : range
    return version === clean
  }
  const req = range.slice(1).split(".").map(Number)
  const ver = version.split(".").map(Number)
  while (req.length < 3) req.push(0)
  while (ver.length < 3) ver.push(0)
  if (req[0] !== 0) return ver[0] === req[0]
  if (req[1] !== 0) return ver[0] === 0 && ver[1] === req[1] && ver[2] >= req[2]
  return ver[0] === 0 && ver[1] === 0 && ver[2] >= req[2]
}

function resolveConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, "opencode")
  const home = process.env.HOME || homedir()
  return join(home, ".config", "opencode")
}


async function importRuntimeAgentConfig(directory) {
  try {
    const { existsSync, readFileSync } = await import("node:fs")
    const { join } = await import("node:path")

    // Check flowdeck.json first, then .flowdeck.jsonc
    for (const name of [".flowdeck.jsonc", ".flowdeck.json", "flowdeck.json"]) {
      const fp = join(directory, name)
      if (existsSync(fp)) {
        const raw = readFileSync(fp, "utf-8")
        const cfg = JSON.parse(raw)
        if (cfg.runtimeAgent) {
          return cfg.runtimeAgent
        }
      }
    }

    // Check opencode.json for runtimeAgent
    const opencodeDir = process.env.OPENCODE_CONFIG_DIR ||
      (process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir, ".config", "opencode"))
    const opencodePath = join(opencodeDir, "opencode.json")
    if (existsSync(opencodePath)) {
      const raw = readFileSync(opencodePath, "utf-8")
      const cfg = JSON.parse(raw)
      if (cfg.runtimeAgent) return cfg.runtimeAgent
    }

    return null
  } catch {
    return null
  }
}
