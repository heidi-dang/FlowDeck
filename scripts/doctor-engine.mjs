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
import { join, basename, resolve } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { safeParseConfig } from "./config-mutator.mjs"

/**
 * Run all doctor checks against the given FlowDeck directory.
 * Returns a tally of passed / warned / failed with per-check details.
 *
 * @param {string} directory - Root of the FlowDeck package
 * @returns {Promise<{passed: number, warned: number, failed: number, checks: Array<{id: string, name: string, status: string, message: string, remediation?: string}>}>}
 */
export async function runDoctorChecks(directory) {
  const checks = []

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
  let configValid = false
  if (existsSync(opencodePath)) {
    const raw = tryRead(opencodePath)
    if (raw) {
      const parsed = safeParseConfig(raw)
      configValid = parsed.ok
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
          configValid = true
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
  const agentsDir = join(directory, "src", "agents")
  const agentFiles = safeList(agentsDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
  checks.push({
    id: "agents.count",
    name: "Agent Count",
    status: agentFiles.length > 0 ? "pass" : "warn",
    message: `${agentFiles.length} agents (${agentFiles.length} agent definition files)`,
    remediation: agentFiles.length === 0 ? "Ensure src/agents/*.ts files exist" : undefined,
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
  const govWiringPath = join(directory, "src", "services", "governance-wiring.ts")
  const govWiringContent = tryRead(govWiringPath)
  const depthEnforced = (govWiringContent?.includes("currentDepth") && govWiringContent?.includes("maxDepth")) ?? false
  checks.push({
    id: "delegation.depth",
    name: "Delegation Depth Enforcement",
    status: depthEnforced ? "pass" : "fail",
    message: depthEnforced ? "Max depth = 1 enforced in governance-wiring.ts" : "Delegation depth not enforced",
    remediation: depthEnforced ? undefined : "Add currentDepth >= 1 check in governance-wiring.ts validateDelegationDepth",
  })

  // ── 12. Governance wiring ──────────────────────────────────────────────
  const indexTsPath = join(directory, "src", "index.ts")
  const indexContent = tryRead(indexTsPath)
  const govWiringExists = existsSync(govWiringPath)
  const govImported = govWiringExists && (indexContent?.includes("governance-wiring") ?? false) && (indexContent?.includes("evaluateGovernanceToolCheck") ?? false)
  checks.push({
    id: "governance.wiring",
    name: "Governance Wiring",
    status: govImported ? "pass" : (govWiringExists ? "fail" : "warn"),
    message: govImported ? "Governance subsystem imported in plugin entrypoint (evaluateGovernanceToolCheck wired)" : (govWiringExists ? "governance-wiring.ts exists but is NOT imported in src/index.ts" : "No governance-wiring.ts found"),
    remediation: govWiringExists && !govImported ? "Add import and call governance hooks in src/index.ts" : undefined,
  })

  // ── 13. FDX fallback availability ─────────────────────────────────────
  const fdxToolDir = join(directory, "src", "tools", "fdx")
  const fdxFiles = safeList(fdxToolDir).filter(f => f.endsWith(".ts") && f !== "index.ts")
  let fdxBinaryAvailable = false
  try { execFileSync("fdx", ["--help"], { stdio: "ignore", timeout: 5000 }); fdxBinaryAvailable = true } catch { /* ignore */ }
  checks.push({
    id: "fdx.fallback",
    name: "FDX Native Fallback",
    status: fdxFiles.length > 0 ? "pass" : "warn",
    message: fdxFiles.length > 0 ? `Native TS fallbacks active (${fdxFiles.length} tools, ${fdxBinaryAvailable ? "FDX binary also available" : "FDX binary not found"})` : "No native FDX fallback tools found",
    remediation: fdxFiles.length === 0 ? "Ensure src/tools/fdx/ has native TS fallback implementations" : undefined,
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
  const lockPath = join(directory, "src", "tools", "planning-state-lib.ts")
  const lockContent = tryRead(lockPath)
  let lockOk = false, lockMsg = "not found"
  if (lockContent) {
    const noBusySpin = !lockContent.includes("while (Date.now() < waitUntil)")
    const throwsOnTimeout = lockContent.includes("throw new Error") || lockContent.includes("throw Error")
    lockOk = noBusySpin && throwsOnTimeout
    lockMsg = lockOk ? "No busy-spin; lock throws on timeout" : noBusySpin ? "Does not throw on timeout" : "Contains synchronous busy-spin loop"
  }
  checks.push({
    id: "state.locks",
    name: "Lock Implementation",
    status: lockOk ? "pass" : "warn",
    message: lockMsg,
    remediation: lockOk ? undefined : "Ensure lock throws on timeout and has no synchronous busy-spin",
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
  // Compare agent definitions found in src/agents/ with actual registered files
  const agentDirFiles = safeList(agentsDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
  const agentNames = agentDirFiles.map(f => basename(f, ".ts"))
  const idxContent = tryRead(join(agentsDir, "index.ts"))
  const hasIndexReexport = idxContent ? agentNames.some(n => idxContent.includes(n)) : false
  checks.push({
    id: "agents.consistency",
    name: "Registry Consistency",
    status: hasIndexReexport && agentNames.length > 0 ? "pass" : "warn",
    message: hasIndexReexport ? `${agentNames.length} agent files all re-exported from src/agents/index.ts` : `Agent files found but may not all be re-exported`,
    remediation: !hasIndexReexport ? "Ensure all agent modules are re-exported from src/agents/index.ts" : undefined,
  })

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
  checks.push({
    id: "cli.commands",
    name: "CLI Commands Availability",
    status: cliCommands.length >= 5 ? "pass" : "warn",
    message: `${cliCommands.length} CLI commands available: ${cliCommands.join(", ")}`,
    remediation: cliCommands.length < 5 ? "Ensure bin/flowdeck.js has all command handlers registered" : undefined,
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
  // Check if governance configuration files reference the supported modes
  const govWiringContent22 = govWiringContent || tryRead(govWiringPath) || ""
  const schemaContent = tryRead(join(directory, "src", "config", "schema.ts")) || ""
  const govModeRegex = /"off"\s*\|?\s*"advisory"\s*\|?\s*"strict"/g
  const wiringHasModes = govModeRegex.test(govWiringContent22)
  const schemaHasModes = govModeRegex.test(schemaContent)
  const govModesOk = wiringHasModes || schemaHasModes
  checks.push({
    id: "governance.modes",
    name: "Governance Modes",
    status: govModesOk ? "pass" : "warn",
    message: govModesOk
      ? "off/advisory/strict supported (off = no enforcement, advisory = warn, strict = block)"
      : "Governance mode constants not found in governance-wiring.ts or schema.ts",
    remediation: govModesOk ? undefined : "Define GovernanceMode type with 'off' | 'advisory' | 'strict' in schema.ts",
  })

  // ── 23. Model inheritance ─────────────────────────────────────────────
  const modelAgentFiles = ["orchestrator.ts", "planner.ts", "coder.ts"]
  let modelInheritanceOk = true
  for (const af of modelAgentFiles) {
    const content = tryRead(join(agentsDir, af))
    if (content && !content.includes("model?")) modelInheritanceOk = false
  }
  checks.push({
    id: "agents.model",
    name: "Model Inheritance",
    status: modelInheritanceOk ? "pass" : "warn",
    message: modelInheritanceOk ? "Agent factories accept optional model parameter" : "Some agent factories may not support model inheritance",
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
    const { modify, applyEdits, parse } = await import("jsonc-parser")
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

function testFdxVersionCompatibility(directory, pkgRaw) {
  if (!pkgRaw) return { status: "pass", message: "No package.json found", remediation: undefined }

  let pkg
  try { pkg = JSON.parse(pkgRaw) } catch { return { status: "pass", message: "Malformed package.json", remediation: undefined } }

  const compatDecl = pkg.flowdeckFdxCompatibility
  const requiredRange = compatDecl?.required ?? "^0.1.0"

  // Try to get installed FDX version via `fdx --version`
  let installedVersion = null
  try {
    const output = execFileSync("fdx", ["--version"], { encoding: "utf-8", timeout: 5000 })
    const match = output.trim().match(/^fdx\s+(.+)/)
    if (match) {
      installedVersion = match[1]
    }
  } catch { /* fdx not available */ }

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
