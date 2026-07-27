#!/usr/bin/env node
/**
 * clean-install-engine.mjs — Atomic FlowDeck Clean Reinstall Engine
 *
 * Single authoritative implementation for the full lifecycle:
 *   1. Discover all OpenCode configuration scopes
 *   2. Identify FlowDeck registrations safely (identity-proven only)
 *   3. Back up all affected files byte-for-byte
 *   4. Remove all proven FlowDeck registrations
 *   5. Verify clean state (machine-readable)
 *   6. Install exact version
 *   7. Run static verification (verify, doctor, config validate)
 *   8. Run real OpenCode runtime agent discovery
 *   9. Report results
 *  10. Roll back automatically if any mandatory stage fails
 *
 * Used by: bin/flowdeck.js (CLI), install.sh (piped bootstrap)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { homedir, hostname } from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { safeParseConfig, applyJsoncEdits, createBackup, atomicWrite } from "./config-mutator.mjs"

// ─── Constants ────────────────────────────────────────────────────────────

const FLOWDECK_PACKAGE = "@heidi-dang/flowdeck"
const LEGACY_PACKAGE = "@dv.nghiem/flowdeck"
const SUPPORTED_IDENTITIES = new Set([FLOWDECK_PACKAGE, LEGACY_PACKAGE])

const STAGE_LABELS = [
  "Prerequisites",
  "Configuration discovery",
  "Backup",
  "Remove existing FlowDeck installations",
  "Verify clean state",
  "Install exact FlowDeck release",
  "Static verification",
  "OpenCode runtime verification",
  "Final report",
]

const LOCK_FILE = ".flowdeck-install.lock"

// ─── CLI Argument Parsing ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    exactVersion: null,
    removeLegacy: true,
    verifyRuntime: true,
    dryRun: false,
    verifyOnly: false,
    uninstallOnly: false,
    project: false,
    global: true,
    keepBackup: false,
    localRepo: null,
    help: false,
    verbose: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "--exact-version": opts.exactVersion = args[++i]; break
      case "--remove-legacy": opts.removeLegacy = true; break
      case "--no-remove-legacy": opts.removeLegacy = false; break
      case "--verify-runtime": opts.verifyRuntime = true; break
      case "--no-verify-runtime": opts.verifyRuntime = false; break
      case "--dry-run": opts.dryRun = true; break
      case "--verify-only": opts.verifyOnly = true; break
      case "--uninstall-only": opts.uninstallOnly = true; break
      case "--project": case "-p": opts.project = true; opts.global = false; break
      case "--global": case "-g": opts.global = true; opts.project = false; break
      case "--keep-backup": opts.keepBackup = true; break
      case "--local-repo": opts.localRepo = args[++i] || process.cwd(); break
      case "--verbose": case "-v": opts.verbose = true; break
      case "--help": case "-h": opts.help = true; break
    }
  }
  return opts
}

// ─── Logging ──────────────────────────────────────────────────────────────

function log(...args) { console.log(...args) }
function warn(...args) { console.warn("[WARN]", ...args) }
function errlog(...args) { console.error("[ERR]", ...args) }
function stage(num, total, label) {
  log(`\n[${num}/${total}] ${label}`)
}

// ─── OpenCode Config Scope Discovery ─────────────────────────────────────

function readConfigScoped(configPath, scope) {
  if (!existsSync(configPath)) return null

  const raw = readFileSync(configPath, "utf-8")
  const isJsonc = raw.includes("//") || raw.includes("/*")
  const parsed = safeParseConfig(raw)

  return {
    path: configPath,
    scope,
    format: isJsonc ? "jsonc" : "json",
    raw,
    ok: parsed.ok,
    data: parsed.ok ? parsed.data : null,
    parseError: parsed.ok ? null : parsed.error,
    configDir: dirname(configPath),
  }
}

function discoverConfigScopes() {
  const scopes = []

  // 1. OPENCODE_CONFIG env var (explicit file path)
  if (process.env.OPENCODE_CONFIG) {
    const configPath = resolve(process.env.OPENCODE_CONFIG)
    const result = readConfigScoped(configPath, "env::OPENCODE_CONFIG")
    if (result) scopes.push(result)
  }

  // 2. OPENCODE_CONFIG_DIR env var (directory containing opencode.json)
  if (process.env.OPENCODE_CONFIG_DIR) {
    const configPath = join(resolve(process.env.OPENCODE_CONFIG_DIR), "opencode.json")
    const result = readConfigScoped(configPath, "env::OPENCODE_CONFIG_DIR")
    if (result) scopes.push(result)
  }

  // 3. XDG_CONFIG_HOME/opencode/opencode.json
  const xdgHome = process.env.XDG_CONFIG_HOME
  if (xdgHome) {
    const configPath = join(xdgHome, "opencode", "opencode.json")
    const result = readConfigScoped(configPath, "xdg-global")
    if (result) scopes.push(result)
  }

  // 4. HOME/.config/opencode/opencode.json (default global)
  const home = homedir()
  const defaultGlobal = join(home, ".config", "opencode", "opencode.json")
  const result = readConfigScoped(defaultGlobal, "global")
  if (result) scopes.push(result)

  // 5. Project opencode.json / opencode.jsonc / .opencode/
  const cwd = process.cwd()
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const configPath = join(cwd, name)
    const result = readConfigScoped(configPath, "project")
    if (result) scopes.push(result)
  }
  const dotOpenCode = join(cwd, ".opencode", "opencode.json")
  const dotResult = readConfigScoped(dotOpenCode, "project")
  if (dotResult) scopes.push(dotResult)

  // Deduplicate by path
  const seen = new Set()
  return scopes.filter(s => {
    if (seen.has(s.path)) return false
    seen.add(s.path)
    return true
  })
}

// ─── Safe FlowDeck Identity Detection ───────────────────────────────────

function isFlowDeckIdentity(ref, verbose = false) {
  if (!ref || typeof ref !== "string") return false

  // Exact package name match
  if (ref === FLOWDECK_PACKAGE || ref === LEGACY_PACKAGE) return true

  // Versioned package: @scope/name@version
  const scopeMatch = ref.match(/^(@[^/]+)\/([^@]+)@(.+)$/)
  if (scopeMatch) {
    const fullName = `${scopeMatch[1]}/${scopeMatch[2]}`
    if (SUPPORTED_IDENTITIES.has(fullName)) return true
  }

  // file:// reference: resolve and check package.json
  if (ref.startsWith("file://")) {
    return isFilePathFlowDeck(ref, verbose)
  }

  // Absolute or relative path — check package.json
  if (ref.startsWith("/") || ref.startsWith(".") || ref.startsWith("~") || /^[A-Za-z]:\\/.test(ref)) {
    return isFilePathFlowDeck(ref, verbose)
  }

  return false
}

function isFilePathFlowDeck(ref, verbose = false) {
  let resolved
  if (ref.startsWith("file://")) {
    try {
      resolved = fileURLToPath(ref)
    } catch {
      // On Windows, fileURLToPath rejects Unix paths like file:///home/user/flowdeck.
      // Fall back to extracting path component after file:// and percent-decoding
      resolved = ref.startsWith("file:///") ? decodeURIComponent(ref.slice(7)) : decodeURIComponent(ref.slice(5))
    }
  } else {
    resolved = resolve(ref.replace(/^~/, homedir()))
  }

  const pkgPath = join(resolved, "package.json")

  // Path exists: check package.json identity (authoritative)
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      const name = pkg.name || ""
      if (SUPPORTED_IDENTITIES.has(name)) return true
      if (verbose) log(`  [debug] package "${name}" at ${resolved} is not FlowDeck`)
      return false
    } catch {
      return false
    }
  }

  // Path does NOT exist -- stale checkout fallback.
  // When the normalized final path component is exactly "flowdeck"
  // (case-insensitive), treat it as a stale FlowDeck checkout reference.
  const parts = resolved.split("/").filter(Boolean)
  const basename = parts.length > 0 ? parts[parts.length - 1] : ""
  const isStale = basename.toLowerCase() === "flowdeck"
  if (isStale && verbose) log(`  [debug] Stale FlowDeck checkout reference: ${ref} -> ${resolved}`)
  return isStale
}

function findFlowDeckPluginEntries(configData, verbose = false) {
  const entries = []
  if (!configData || !Array.isArray(configData.plugin)) return entries

  for (let i = 0; i < configData.plugin.length; i++) {
    const ref = String(configData.plugin[i])
    if (isFlowDeckIdentity(ref, verbose)) {
      entries.push({ index: i, ref })
    }
  }
  return entries
}

function checkDefaultAgentOwnership(configDir) {
  const manifestPath = join(configDir, ".flowdeck-manifest.json")
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
      return {
        owned: manifest.defaultAgentAdded === true,
        previousValue: manifest.previousDefaultAgent ?? null,
        value: manifest.defaultAgentAdded ? "heidi" : null,
      }
    } catch { /* fall through */ }
  }
  return { owned: false, previousValue: null, value: null }
}

// ─── Transactional Backup ─────────────────────────────────────────────────

class Transaction {
  constructor() {
    this.backups = []
    this.plan = []
    this.failed = false
    this.failedStage = null
    this.completed = false
    this.lockPath = null
  }

  acquireLock(directory) {
    const lockDir = join(directory, ".fd-plan")
    mkdirSync(lockDir, { recursive: true })
    this.lockPath = join(lockDir, LOCK_FILE)

    if (existsSync(this.lockPath)) {
      try {
        const lockData = JSON.parse(readFileSync(this.lockPath, "utf-8"))
        const age = Date.now() - (lockData.acquiredAt || 0)
        if (age < 300000) {
          throw new Error(
            `Installation lock held by PID ${lockData.pid} since ${new Date(lockData.acquiredAt).toISOString()}`
          )
        }
        warn(`Stale lock found (${Math.round(age / 1000)}s old) — overriding`)
      } catch (e) {
        if (e.message && e.message.includes("Installation lock held")) throw e
        warn(`Could not read lock file: ${e.message} — overriding`)
      }
    }

    writeFileSync(this.lockPath, JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
      hostname: hostname(),
    }, null, 2))
  }

  releaseLock() {
    if (this.lockPath && existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath) } catch {}
    }
  }

  backup(description, filePath) {
    if (!existsSync(filePath)) return null
    const backupPath = createBackup(filePath)
    if (backupPath) {
      this.backups.push({ description, originalPath: filePath, backupPath })
      this.plan.push({ action: "backup", description, filePath, backupPath })
    }
    return backupPath
  }

  addPlanStep(action, description, filePath, detail = null) {
    this.plan.push({ action, description, filePath, detail })
  }

  fail(stageName, reason) {
    this.failed = true
    this.failedStage = stageName
    errlog(`Stage "${stageName}" failed: ${reason}`)
  }

  rollback() {
    log("\n  ── Rolling back ──")
    let restored = 0
    for (const backup of [...this.backups].reverse()) {
      try {
        copyFileSync(backup.backupPath, backup.originalPath)
        log(`  ✓ Restored: ${backup.description}`)
        restored++
      } catch (e) {
        warn(`Failed to restore ${backup.originalPath}: ${e.message}`)
      }
    }
    if (this.lockPath) this.releaseLock()
    log(`  Restored ${restored} file(s)\n`)
  }

  displayPlan() {
    log("\n  Transaction plan:")
    log(`  ${"-".repeat(60)}`)
    for (const step of this.plan) {
      log(`  ${step.action.padEnd(12)} ${step.description}`)
      if (step.filePath) log(`  ${" ".repeat(12)} ${step.filePath}`)
    }
    log(`  ${"-".repeat(60)}`)
  }
}

// ─── Clean State Verification ─────────────────────────────────────────────

function verifyCleanState(scopes) {
  log("\n  Clean-state verification:")

  let configsChecked = 0
  let flowdeckPluginEntries = 0
  let legacyPluginEntries = 0
  let verifiedFlowdeckPaths = 0
  let parseErrors = 0

  for (const scope of scopes) {
    configsChecked++
    if (!scope.ok) {
      parseErrors++
      log(`  ✗ Parse error: ${scope.path}`)
      continue
    }

    const allPlugins = scope.data?.plugin || []
    for (const p of allPlugins) {
      if (isFlowDeckIdentity(String(p))) {
        flowdeckPluginEntries++
        if (String(p).includes(LEGACY_PACKAGE)) legacyPluginEntries++
        if (p.startsWith("file://") || p.startsWith("/") || p.startsWith(".")) verifiedFlowdeckPaths++
      }
    }

    // Check manifests
    const manifestPath = join(scope.configDir, ".flowdeck-manifest.json")
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
        if (manifest.pluginRef && isFlowDeckIdentity(manifest.pluginRef)) {
          flowdeckPluginEntries++
        }
      } catch {}
    }
  }

  const clean = flowdeckPluginEntries === 0 && legacyPluginEntries === 0 &&
    verifiedFlowdeckPaths === 0 && parseErrors === 0

  log(`    Configs checked: ${configsChecked}`)
  log(`    FlowDeck plugin entries: ${flowdeckPluginEntries}`)
  log(`    Legacy plugin entries: ${legacyPluginEntries}`)
  log(`    Verified FlowDeck paths: ${verifiedFlowdeckPaths}`)
  log(`    Parse errors: ${parseErrors}`)
  log(`    Clean: ${clean ? "YES" : "NO"}`)

  return { clean, configsChecked, flowdeckPluginEntries, legacyPluginEntries, verifiedFlowdeckPaths, parseErrors }
}

// ─── Remove FlowDeck Registrations ────────────────────────────────────────

function removeFlowDeckFromScope(scope, transaction, opts) {
  const { path: configPath, data, raw, configDir } = scope

  if (!data) {
    log(`  - ${scope.scope}: no configuration data`)
    return { removed: false, manifestDeleted: false }
  }

  const flowdeckEntries = findFlowDeckPluginEntries(data, opts.verbose)
  const manifestPath = join(configDir, ".flowdeck-manifest.json")
  const manifestExists = existsSync(manifestPath)

  if (flowdeckEntries.length === 0 && !manifestExists) {
    log(`  - ${scope.scope}: no FlowDeck registrations found`)
    return { removed: false, manifestDeleted: false }
  }

  const ownership = checkDefaultAgentOwnership(configDir)

  let desc = `Clean ${scope.scope} config`
  const details = []
  if (flowdeckEntries.length > 0) details.push(`${flowdeckEntries.length} plugin entries`)
  if (manifestExists) details.push("manifest")
  if (ownership.owned) details.push("default_agent")

  if (opts.dryRun) {
    log(`  [DRY RUN] Would ${desc}: ${details.join(", ")}`)
    transaction.addPlanStep("dry-run", desc, configPath, details.join(", "))
    return { removed: false, manifestDeleted: false, dryRun: true }
  }

  transaction.backup(`config: ${scope.scope}`, configPath)

  const edits = []

  // Remove FlowDeck plugin entries
  if (flowdeckEntries.length > 0) {
    const plugins = Array.isArray(data.plugin) ? [...data.plugin] : []
    const indicesToRemove = new Set(flowdeckEntries.map(e => e.index))
    const filtered = plugins.filter((_, i) => !indicesToRemove.has(i))
    edits.push({ path: ["plugin"], value: filtered })

    // Log stale entries distinctly
    for (const entry of flowdeckEntries) {
      const isFileRef = entry.ref.startsWith("file://") || entry.ref.startsWith("/") || entry.ref.startsWith(".")
      if (isFileRef) {
        const filePath = entry.ref.startsWith("file://") ? fileURLToPath(entry.ref) : resolve(entry.ref.replace(/^~/, homedir()))
        if (!existsSync(filePath)) {
          log("  - Removed stale FlowDeck checkout reference: " + entry.ref)
        }
      }
    }
  }

  // Handle default_agent according to ownership
  if (ownership.owned) {
    if (ownership.previousValue !== null && ownership.previousValue !== undefined) {
      edits.push({ path: ["default_agent"], value: ownership.previousValue })
      log(`  ✓ Restored default_agent to "${ownership.previousValue}"`)
    } else {
      edits.push({ path: ["default_agent"], value: undefined })
      log(`  ✓ Removed default_agent (was set by FlowDeck)`)
    }
  } else if (data.default_agent && (data.default_agent === "heidi" || data.default_agent === "orchestrator")) {
    // No manifest evidence — preserve user's setting and report it
    log(`  ℹ Preserved default_agent "${data.default_agent}" (ownership not proven)`)
  }

  // Apply edits
  if (edits.length > 0 && raw) {
    const updatedContent = applyJsoncEdits(raw, edits)
    atomicWrite(configPath, updatedContent)
    log(`  ✓ ${desc}: ${details.join(", ")}`)
  }

  // Remove manifest
  let manifestDeleted = false
  if (manifestExists) {
    try {
      unlinkSync(manifestPath)
      manifestDeleted = true
      log(`  ✓ Removed manifest: ${manifestPath}`)
    } catch (e) {
      warn(`Could not remove manifest: ${e.message}`)
    }
  }

  return { removed: flowdeckEntries.length > 0, manifestDeleted }
}

function cleanPackageDirectories(transaction, opts) {
  const locations = []

  // npm global root
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 5000 }).trim()
    locations.push(globalRoot)
  } catch {}

  // OpenCode cache paths
  const home = homedir()
  for (const cachePath of [
    join(home, ".cache", "opencode", "packages"),
    join(home, ".local", "share", "opencode", "packages"),
  ]) {
    if (existsSync(cachePath)) {
      try {
        const entries = readdirSync(cachePath)
        for (const entry of entries) {
          const fullPath = join(cachePath, entry)
          if (isFilePathFlowDeck(fullPath)) locations.push(fullPath)
        }
      } catch {}
    }
  }

  // Current project node_modules
  const projectRoot = process.cwd()
  for (const pkg of [FLOWDECK_PACKAGE, LEGACY_PACKAGE]) {
    const parts = pkg.split("/")
    const scopeDir = parts[0]
    const pkgDir = parts[1]
    const npmPath = join(projectRoot, "node_modules", scopeDir, pkgDir)
    if (existsSync(npmPath) && isFilePathFlowDeck(npmPath)) locations.push(npmPath)
  }

  for (const loc of locations) {
    if (!isFilePathFlowDeck(loc)) continue
    if (opts.dryRun) {
      log(`  [DRY RUN] Would remove package: ${loc}`)
      transaction.addPlanStep("dry-run", "remove package", loc)
      continue
    }
    const pkg = JSON.parse(readFileSync(join(loc, "package.json"), "utf-8"))
    log(`  ✓ Removed package directory: ${loc} (${pkg.name})`)
    rmSync(loc, { recursive: true, force: true })
  }
}

// ─── Exact Version Installation ──────────────────────────────────────────

function installExactVersion(configDir, opts) {
  const version = opts.exactVersion
  if (!version) throw new Error("exactVersion is required for installation")

  const spec = `${FLOWDECK_PACKAGE}@${version}`
  const configPath = join(configDir, "opencode.json")
  const manifestPath = join(configDir, ".flowdeck-manifest.json")

  mkdirSync(configDir, { recursive: true })

  let existingData = { plugin: [] }
  let rawContent = "{}"
  if (existsSync(configPath)) {
    rawContent = readFileSync(configPath, "utf-8")
    const parsed = safeParseConfig(rawContent)
    if (parsed.ok && parsed.data) existingData = parsed.data
  }

  const hasExistingDefault = existingData.default_agent != null

  // Remove any existing FlowDeck entries, then add exact spec
  let plugins = Array.isArray(existingData.plugin) ? [...existingData.plugin] : []
  plugins = plugins.filter(p => !isFlowDeckIdentity(String(p)))
  plugins.push(spec)

  const edits = [
    { path: ["plugin"], value: plugins },
  ]
  if (!hasExistingDefault) {
    edits.push({ path: ["default_agent"], value: "heidi" })
  }

  const updatedContent = applyJsoncEdits(rawContent, edits)
  atomicWrite(configPath, updatedContent)

  const manifest = {
    schemaVersion: 2,
    pluginRef: spec,
    pluginAdded: true,
    pluginPreviouslyPresent: false,
    defaultAgentAdded: !hasExistingDefault,
    previousDefaultAgent: hasExistingDefault ? existingData.default_agent : null,
    installationMode: opts.localRepo ? "local-repo" : "npm",
    checkoutPath: opts.localRepo || null,
    version: opts.exactVersion,
    installedAt: new Date().toISOString(),
    ownedAgents: ["heidi", "orchestrator"],
  }
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

  log(`  ✓ Installed ${spec}`)
  if (!hasExistingDefault) log(`  ✓ Set default_agent to heidi`)
  else log(`  ✓ Preserved existing default_agent: "${existingData.default_agent}"`)
  log(`  ✓ Config: ${configPath}`)

  return { spec, configPath, manifestPath }
}

// ─── Static Verification ─────────────────────────────────────────────────

function runStaticVerification(pkgRoot, opts) {
  log("\n  Static checks:")
  let pass = 0
  let fail = 0
  const checks = []

  const pkgPath = join(pkgRoot, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    const ok = pkg.name === FLOWDECK_PACKAGE
    checks.push({ name: "Package identity", ok, detail: pkg.name })
    if (ok) pass++; else fail++
  }

  checks.push({ name: "Plugin version", ok: true, detail: `v${opts.exactVersion || "unknown"}` })
  pass++

  const distPath = join(pkgRoot, "dist", "index.js")
  if (existsSync(distPath)) {
    const distContent = readFileSync(distPath, "utf-8")
    const hasModern = distContent.includes("@heidi-dang/flowdeck") || distContent.includes("server:")
    checks.push({ name: "Modern plugin contract", ok: hasModern, detail: hasModern ? "{ id, server } present" : "not detected" })
    if (hasModern) pass++; else fail++
  }

  const registryFile = join(pkgRoot, "src", "services", "canonical-registry.ts")
  if (existsSync(registryFile)) {
    const content = readFileSync(registryFile, "utf-8")
    const hasHeidi = content.includes('id: "heidi"')
    const hasPrimary = content.includes('mode: "primary"')
    const notHidden = !content.includes('hidden: true')
    checks.push({ name: "Heidi agent: primary mode", ok: hasHeidi && hasPrimary, detail: hasHeidi ? "found" : "not found" })
    if (hasHeidi && hasPrimary) pass++; else fail++
    checks.push({ name: "Heidi hidden = false", ok: notHidden, detail: notHidden ? "not hidden" : "hidden is true" })
    if (notHidden) pass++; else fail++
  }

  const skillsDir = join(pkgRoot, "src", "skills")
  if (existsSync(skillsDir)) {
    const skillDirs = readdirSync(skillsDir).filter(f => f !== ".DS_Store")
    let valid = 0
    for (const entry of skillDirs) {
      const sf = join(skillsDir, entry, "SKILL.md")
      if (existsSync(sf)) {
        const content = readFileSync(sf, "utf-8")
        if (content.startsWith("---") && content.includes("name:")) valid++
      }
    }
    checks.push({ name: "Skills validation", ok: valid > 0, detail: `${valid}/${skillDirs.length} valid` })
    if (valid > 0) pass++; else fail++
  }

  for (const c of checks) {
    log(`    ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
  }
  log(`    ${pass} passed, ${fail} failed`)

  return { checks, pass, fail }
}

// ─── OpenCode Runtime Verification ───────────────────────────────────────

function findOpenCode() {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which"
    const output = execFileSync(whichCmd, ["opencode"], { encoding: "utf-8", timeout: 5000 })
    return output.trim().split("\n")[0]
  } catch {
    return null
  }
}

function verifyOpenCodeRuntime() {
  log("\n  OpenCode runtime verification:")

  const opencodePath = findOpenCode()
  if (!opencodePath) {
    warn("  opencode not found in PATH")
    return { ok: false, reason: "opencode not found in PATH", skipped: false }
  }
  log(`  OpenCode: ${opencodePath}`)

  let result
  try {
    result = execFileSync("opencode", ["--print-logs", "--log-level", "DEBUG", "agent", "list"], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e) {
    const stderr = e.stderr || ""
    warn(`OpenCode agent list failed`)

    if (stderr.includes("Plugin export is not a function")) {
      return { ok: false, reason: "Plugin export is not a function (legacy contract)", skipped: false }
    }
    if (stderr.includes("failed to load plugin")) {
      return { ok: false, reason: "failed to load plugin", skipped: false }
    }
    if (stderr.includes("plugin config hook failed")) {
      return { ok: false, reason: "plugin config hook failed", skipped: false }
    }
    return { ok: false, reason: e.message, skipped: false }
  }

  const output = result
  log(`  agent list output (first 2000 chars):\n  ${output.slice(0, 2000).replace(/\n/g, "\n  ")}`)

  const hasHeidi = output.includes("heidi") || output.includes("Heidi")
  const hasPrimary = output.includes("primary")
  const hasHidden = output.includes("hidden: true")
  const hasLegacyError = output.includes("Plugin export is not a function")
  const hasLoadError = output.includes("failed to load plugin")
  const hasOrchestrator = output.includes("orchestrator") || output.includes("Orchestrator")

  log(`  Heidi found: ${hasHeidi}`)
  log(`  Heidi primary: ${hasPrimary}`)
  log(`  Heidi hidden: ${hasHidden ? "YES (problem)" : "no"}`)
  log(`  Orchestrator found: ${hasOrchestrator}`)
  log(`  Legacy plugin error: ${hasLegacyError}`)
  log(`  Plugin load error: ${hasLoadError}`)

  const ok = hasHeidi && hasPrimary && !hasHidden && !hasLegacyError && !hasLoadError
  return { ok, details: { hasHeidi, hasPrimary, hasHidden, hasOrchestrator, hasLegacyError, hasLoadError }, skipped: false }
}

function runProviderSmoke() {
  log("\n  Provider smoke test:")

  const hasCredentials = process.env.OPENCODE_API_KEY || process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY || process.env.VERTEX_API_KEY

  if (!hasCredentials) {
    log("  SKIPPED — no configured credentials")
    return { ok: true, skipped: true }
  }

  try {
    const result = execFileSync("opencode", [
      "run", "--no-write",
      "--prompt", "Inspect this project without modifying files. Return exactly: FLOWDECK_RUNTIME_OK",
    ], { encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] })

    const hasOk = result.includes("FLOWDECK_RUNTIME_OK")
    log(`  ${hasOk ? "PASS" : "FAIL"}`)
    return { ok: hasOk, skipped: false }
  } catch (e) {
    warn(`Provider smoke test failed: ${e.message}`)
    return { ok: false, skipped: false, reason: e.message }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

function reportResults(results) {
  const { cleanState, runtimeResult, smokeResult, staticResult, transaction, opts, installedScope } = results

  log(`\n${"=".repeat(60)}`)
  log(`  FlowDeck Installation Report`)
  log(`${"=".repeat(60)}\n`)
  log(`  Package: ${FLOWDECK_PACKAGE}`)
  log(`  Version: ${opts?.exactVersion || "unknown"}`)

  if (installedScope) {
    log(`  Install path: ${installedScope.configPath}`)
  }
  if (cleanState) {
    log(`  Plugin registrations: ${cleanState.flowdeckPluginEntries}`)
    log(`  Legacy registrations: ${cleanState.legacyPluginEntries}`)
  }
  if (runtimeResult) {
    log(`  Heidi runtime agent: ${runtimeResult.ok ? "primary, visible" : runtimeResult.skipped ? "SKIPPED" : "FAILED"}`)
    log(`  OpenCode runtime checks: ${runtimeResult.ok ? "PASS" : runtimeResult.skipped ? "SKIPPED" : "FAIL"}`)
  }
  if (smokeResult) {
    log(`  Provider smoke: ${smokeResult.ok ? (smokeResult.skipped ? "SKIPPED" : "PASS") : "FAIL"}`)
  }
  if (staticResult) {
    log(`  FlowDeck static checks: ${staticResult.fail === 0 ? "PASS" : "FAIL"}`)
  }

  if (transaction?.backups?.length > 0) {
    log(`  Backup: ${transaction.backups[0].backupPath}`)
  }

  log("")

  if (transaction?.failed) {
    errlog(`  Status: FAILED at stage "${transaction.failedStage}"`)
    errlog(`  Configuration was rolled back.`)
    return { ok: false, failedStage: transaction.failedStage }
  }

  if (opts?.dryRun) {
    log(`  Status: DRY RUN — no files modified`)
    return { ok: true, dryRun: true }
  }

  log(`  Status: INSTALLATION VERIFIED`)
  log(`  A fresh OpenCode session is required to load the new plugin.`)

  if (runtimeResult && !runtimeResult.skipped && runtimeResult.ok) {
    log(`  Runtime: Heidi is available as a primary agent.`)
  }

  if (runtimeResult && !runtimeResult.skipped && !runtimeResult.ok) {
    log(`  OPENCODE-FRESH-SESSION-REQUIRED`)
  }

  transaction?.releaseLock()
  return { ok: true }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function runCleanInstall(userOpts = {}) {
  const totalStages = STAGE_LABELS.length
  const transaction = new Transaction()
  const opts = { ...parseArgs(), ...userOpts }
  let pkgRoot, runtimeResult, smokeResult, staticResult, installedScope

  const __dirname = dirname(fileURLToPath(import.meta.url))
  pkgRoot = resolve(__dirname, "..")

  try {
    // Stage 1: Prerequisites
    stage(1, totalStages, "Prerequisites")
    const nodeVersion = process.version
    log(`  Node.js: ${nodeVersion}`)
    if (parseInt(nodeVersion.slice(1)) < 18) throw new Error("Node.js >= 18 required")

    try {
      const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim()
      log(`  npm: ${npmVersion}`)
    } catch { throw new Error("npm is required but not found") }

    const opencodePath = findOpenCode()
    log(`  OpenCode: ${opencodePath || "not found in PATH (will still verify installation)"}`)

    const pkgPath = join(pkgRoot, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      if (pkg.name !== FLOWDECK_PACKAGE) warn(`Package name is "${pkg.name}", expected "${FLOWDECK_PACKAGE}"`)
      log(`  Package: ${pkg.name} v${pkg.version}`)
      opts.exactVersion = opts.exactVersion || pkg.version
    }
    if (!opts.exactVersion) throw new Error("Could not determine package version")
    log("  Prerequisites: OK")

    // Stage 2: Configuration discovery
    stage(2, totalStages, "Configuration discovery")
    const scopes = discoverConfigScopes()
    if (scopes.length === 0) {
      log("  No OpenCode configuration found — will create new")
    } else {
      log(`  Found ${scopes.length} config scope(s):`)
      for (const scope of scopes) {
        const entries = scope.ok ? findFlowDeckPluginEntries(scope.data) : []
        log(`    ${scope.scope}: ${scope.path}`)
        log(`      Format: ${scope.format}, FlowDeck refs: ${entries.length}`)
        if (entries.length > 0) entries.forEach(e => log(`        [${e.index}] ${e.ref}`))
        if (scope.ok && scope.data?.default_agent) {
          const ownership = checkDefaultAgentOwnership(scope.configDir)
          log(`      Default agent: "${scope.data.default_agent}"${ownership.owned ? " (FlowDeck-owned)" : ""}`)
        }
      }
    }

    // Stage 3: Backup
    stage(3, totalStages, "Backup")
    if (!opts.dryRun) {
      transaction.acquireLock(pkgRoot)
      for (const scope of scopes) {
        if (scope.ok) transaction.backup(`${scope.scope} pre-clean`, scope.path)
      }
      log(`  Created ${transaction.backups.length} backup(s)`)
    } else { log("  [DRY RUN] Backups would be created") }

    // Stage 4: Remove
    stage(4, totalStages, "Remove existing FlowDeck installations")
    if (opts.verifyOnly || opts.uninstallOnly) {
      log("  Skipping removal (verify-only mode)")
    } else {
      for (const scope of scopes) {
        if (!scope.ok) { warn(`Skipping malformed config: ${scope.path}`); continue }
        removeFlowDeckFromScope(scope, transaction, opts)
      }
      cleanPackageDirectories(transaction, opts)
    }

    // Stage 5: Verify clean state (fresh re-read after removal)
    stage(5, totalStages, "Verify clean state")
    const cleanState = verifyCleanState(discoverConfigScopes())
    if (!cleanState.clean && !opts.verifyOnly && !opts.dryRun) {
      transaction.fail("Verify clean state", `Found ${cleanState.flowdeckPluginEntries} FlowDeck entries remaining`)
      throw new Error(`Clean state verification failed: ${cleanState.flowdeckPluginEntries} entries remain`)
    }
    log(`  Clean state: ${cleanState.clean ? "PASS" : "FAIL"}`)

    if (opts.uninstallOnly) {
      log("\n  Uninstall complete. Not proceeding with installation.")
      transaction.completed = true
      return reportResults({ cleanState, transaction, opts })
    }
    if (opts.verifyOnly) {
      log("\n  Verification complete. Not proceeding with installation.")
      transaction.completed = true
      return reportResults({ cleanState, transaction, opts })
    }

    // Stage 6: Install
    stage(6, totalStages, "Install exact FlowDeck release")
    if (opts.dryRun) {
      log(`  [DRY RUN] Would install: ${FLOWDECK_PACKAGE}@${opts.exactVersion}`)
    } else {
      const targetConfigDir = opts.project
        ? join(process.cwd(), ".opencode")
        : (process.env.OPENCODE_CONFIG_DIR
            ? resolve(process.env.OPENCODE_CONFIG_DIR)
            : join(homedir(), ".config", "opencode"))
      installedScope = installExactVersion(targetConfigDir, opts)
    }

    // Stage 7: Static verification
    stage(7, totalStages, "Static verification")
    if (!opts.dryRun) {
      staticResult = runStaticVerification(pkgRoot, opts)
      if (staticResult.fail > 0) {
        transaction.fail("Static verification", `${staticResult.fail} check(s) failed`)
        throw new Error(`Static verification failed`)
      }
    }

    // Stage 8: Runtime verification
    stage(8, totalStages, "OpenCode runtime verification")
    if (opts.dryRun || !opts.verifyRuntime) {
      runtimeResult = { ok: !opts.dryRun, skipped: !opts.verifyRuntime }
      log(`  ${runtimeResult.skipped ? "SKIPPED" : "DRY RUN"}`)
    } else {
      runtimeResult = verifyOpenCodeRuntime()
      if (!runtimeResult.ok && !runtimeResult.skipped) {
        transaction.fail("Runtime verification", runtimeResult.reason || "failed")
        throw new Error(`Runtime verification failed`)
      }
    }

    // Provider smoke test
    if (!opts.dryRun && opts.verifyRuntime && !opts.verifyOnly) {
      smokeResult = runProviderSmoke()
    } else {
      smokeResult = { ok: true, skipped: true }
    }

    transaction.completed = true

  } catch (e) {
    if (!transaction.failed) {
      transaction.fail(STAGE_LABELS[Math.min(transaction.plan.length || 1, totalStages - 1)], e.message)
    }
    transaction.rollback()
    errlog(`\n  ✗ Installation FAILED: ${e.message}`)
    process.exitCode = 1
  }

  // Stage 9: Report
  stage(9, totalStages, "Final report")
  return reportResults({
    cleanState: await verifyCleanState(discoverConfigScopes()),
    runtimeResult, smokeResult, staticResult, transaction, opts, installedScope,
  })
}

export { runCleanInstall }

// ─── CLI Entry (only when executed directly) ─────────────────────────────

const isMainModule = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)

if (isMainModule) {
  const opts = parseArgs()

  if (opts.help) {
    console.log(`
FlowDeck Clean Install
  Atomic verified clean reinstall of FlowDeck for OpenCode.

Usage:
  flowdeck clean-install [options]

Options:
  --exact-version <ver>   Install an exact version
  --remove-legacy         Remove legacy @dv.nghiem registrations (default: true)
  --no-remove-legacy      Preserve legacy registrations
  --verify-runtime        Verify through real OpenCode runtime (default: true)
  --no-verify-runtime     Skip runtime verification
  --dry-run               Show what would be done without making changes
  --verify-only           Only verify current state, don't install
  --uninstall-only        Only uninstall, don't reinstall
  --project, -p           Install in project .opencode/
  --global, -g            Install globally (default)
  --keep-backup           Keep backup files after successful install
  --local-repo <path>     Install from local repository checkout
  --verbose, -v           Verbose output
  --help, -h              Show this help
`)
    process.exit(0)
  }

  runCleanInstall().catch(e => {
    errlog(e.message)
    process.exit(1)
  })
}
