#!/usr/bin/env node
/**
 * doctor-service.mjs — Bridge between the CLI/installer and the doctor engine.
 *
 * Resolves the doctor implementation from (in order):
 *   1. Compiled dist/index.js (packaged npm install)
 *   2. TypeScript source via bun (development)
 *
 * Used by:
 *   - bin/flowdeck.js (CLI doctor command)
 *   - install.sh (doctor integration)
 */

import { resolve, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolveDoctorExitCode as canonicalResolveDoctorExitCode } from "../src/doctor/exit-code.mjs"

// Resolve bun binary path for reliable subprocess detection
let BUN_BIN_CACHED = null
function bunBin() {
  if (BUN_BIN_CACHED !== null) return BUN_BIN_CACHED
  if (process.env.FLOWDECK_BUN_BIN) {
    BUN_BIN_CACHED = process.env.FLOWDECK_BUN_BIN
    return BUN_BIN_CACHED
  }
  if (typeof process.versions.bun === "string") {
    BUN_BIN_CACHED = process.execPath
    return BUN_BIN_CACHED
  }
  BUN_BIN_CACHED = "bun"
  return BUN_BIN_CACHED
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, "..")

// Known valid profile names (must match src/doctor/profiles/profiles.ts)
const KNOWN_PROFILES = new Set([
  "minimal",
  "recommended-dev",
  "full-dev",
  "ci",
  "release",
])

// ─── Engine Resolution ─────────────────────────────────────────────────

function resolveDistPath() {
  return pathToFileURL(join(PKG_ROOT, "dist", "index.js")).href
}

async function loadDoctorEngine() {
  // Try 1: Compiled dist (packaged npm install)
  const distUrl = resolveDistPath()
  try {
    const mod = await import(distUrl)
    if (typeof mod.runDoctor === "function") {
      return {
        runDoctor: mod.runDoctor,
        formatReport: mod.formatReport,
        formatJSON: mod.formatJSON,
        source: "dist",
      }
    }
  } catch {
    // dist not available
  }

  // Try 2: Run via bun (development)
  if (hasBun()) {
    return { runViaBun: true, source: "bun" }
  }

  throw new Error(
    "Doctor engine not available. Build the project first: bun run build"
  )
}

function hasBun() {
  try {
    const bin = bunBin()
    execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: "ignore",
      shell: process.platform === "win32",
    })
    return true
  } catch {
    return false
  }
}

function runViaBun(directory, options = {}) {
  // Use bun to import and execute the TypeScript doctor module inline
  const srcPath = join(PKG_ROOT, "src/doctor/doctor.ts")
  const distPath = join(PKG_ROOT, "dist/index.js")
  const doctorPath = existsSync(srcPath) ? srcPath : distPath
  const opts = {
    directory: directory || PKG_ROOT,
    options: {
      json: false,
      strict: !!options.strict,
      verbose: !!options.verbose,
      applyRecommended: !!options.applyRecommended,
      profile: options.profile || "recommended-dev",
      nonInteractive: !!options.nonInteractive,
    },
  }

  const script = [
    `import { runDoctor } from ${JSON.stringify(doctorPath)};`,
    `const r = await runDoctor(${JSON.stringify(opts.directory)}, ${JSON.stringify(opts.options)});`,
    `process.stdout.write("__FLOWDECK_DOCTOR_JSON_START__" + JSON.stringify(r) + "__FLOWDECK_DOCTOR_JSON_END__");`,
  ].join("\n")

  try {
    const output = execFileSync(bunBin(), ["-e", script], {
      cwd: directory || PKG_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    const match = output.match(/__FLOWDECK_DOCTOR_JSON_START__(.*)__FLOWDECK_DOCTOR_JSON_END__/s);
    if (match) return JSON.parse(match[1]);
    return JSON.parse(output.trim())  } catch (e) {
    const stderr = String(e.stderr || "");
    const stdout = String(e.stdout || "");
    const match = stdout.match(/__FLOWDECK_DOCTOR_JSON_START__(.*)__FLOWDECK_DOCTOR_JSON_END__/s);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    const errLines = stderr.trim().split("\n").filter(l => l.trim() && !l.includes("Bun v"));
    throw new Error(errLines.join("\n") || e.message);
  }
}

// ─── Public API ────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1
export const EXIT_HEALTHY = 0
export const EXIT_FAILURE = 1
export const EXIT_ERROR = 2
export { KNOWN_PROFILES }

/**
 * Run the doctor engine and return a report.
 * @param {string} [directory] - Package root directory
 * @param {object} [options]
 * @param {boolean} [options.json] - Output JSON (not used here, for CLI)
 * @param {boolean} [options.strict] - Strict mode
 * @param {boolean} [options.verbose] - Verbose output
 * @param {boolean} [options.applyRecommended] - Apply auto-fixes
 * @param {string} [options.profile] - Profile name
 * @param {boolean} [options.nonInteractive] - Non-interactive mode
 * @returns {Promise<object>} Doctor report
 */
export async function runDoctor(directory = PKG_ROOT, options = {}) {
  const engine = await loadDoctorEngine()

  if (engine.runViaBun) {
    return runViaBun(directory, options)
  }

  return engine.runDoctor(directory, {
    json: false,
    strict: !!options.strict,
    verbose: !!options.verbose,
    applyRecommended: !!options.applyRecommended,
    profile: options.profile || "recommended-dev",
    nonInteractive: !!options.nonInteractive,
  })
}

/**
 * Format a doctor report as human-readable text.
 * @param {object} report - Doctor report
 * @param {boolean} [verbose] - Include verbose details
 * @returns {string} Formatted text
 */
export async function formatReport(report, verbose = false) {
  const engine = await loadDoctorEngine()
  if (engine.formatReport) {
    return engine.formatReport(report, verbose)
  }
  // Fallback: build from scratch
  return buildFallbackReport(report, verbose)
}

/**
 * Format a doctor report as JSON.
 * @param {object} report - Doctor report
 * @returns {string} JSON string
 */
export async function formatJSON(report) {
  return JSON.stringify({ schemaVersion: 1, ...report }, null, 2)
}

/**
 * Normalize a raw engine report into the stable service contract shape.
 * Adds top-level fields required by tests and the CLI JSON contract.
 */
function normalizeReport(report, pkgName, pkgVersion) {
  const s = report.summary || {}
  const errors = s.errors ?? 0
  const warnings = s.warnings ?? 0
  const passed = s.passed ?? 0
  const failed = errors
  const status = errors > 0 ? "unhealthy" : warnings > 0 ? "degraded" : "healthy"
  return {
    ...report,
    packageName: pkgName,
    packageVersion: pkgVersion,
    passed,
    warned: warnings,
    failed,
    status,
  }
}

let _pkgName = "@heidi-dang/flowdeck"
let _pkgVersion = "0.0.0"
try {
  const { readFileSync: _rfs } = await import("node:fs")
  const _pkg = JSON.parse(_rfs(join(PKG_ROOT, "package.json"), "utf-8"))
  _pkgName = _pkg.name || _pkgName
  _pkgVersion = _pkg.version || _pkgVersion
} catch { /* ignore */ }

export const resolveDoctorExitCode = canonicalResolveDoctorExitCode

/**
 * Backward-compatible wrapper: runDoctorService(directory, options)
 * Returns { report, exitCode, stdout, stderr } matching the main branch contract.
 * Used by src/doctor/cli.mjs and tests.
 */
export async function runDoctorService(directory = PKG_ROOT, options = {}) {
  // Validate profile before calling the engine
  const profile = options.profile || "recommended-dev"
  if (profile !== "recommended-dev" && !KNOWN_PROFILES.has(profile)) {
    return {
      report: null,
      exitCode: 2,
      stdout: "",
      stderr: `Unknown profile: "${profile}". Valid profiles: ${[...KNOWN_PROFILES].join(", ")}\n`,
    }
  }

  // Validate that the directory looks like a package root (has package.json)
  try {
    const { existsSync: _exists } = await import("node:fs")
    if (!_exists(join(directory, "package.json"))) {
      return {
        report: null,
        exitCode: 2,
        stdout: "",
        stderr: `Doctor engine error: No package.json found in directory: ${directory}\n`,
      }
    }
  } catch { /* ignore fs import errors */ }

  try {
    const rawReport = await runDoctor(directory, options)
    const report = normalizeReport(rawReport, _pkgName, _pkgVersion)
    const exitCode = resolveDoctorExitCode(report, !!options.strict)
    const text = await formatReport(report, !!options.verbose)
    const stdout = options.json
      ? JSON.stringify({ schemaVersion: 1, ...report }, null, 2) + "\n"
      : text
    return { report, exitCode, stdout, stderr: "" }
  } catch (err) {
    return {
      report: null,
      exitCode: 2,
      stdout: "",
      stderr: `Doctor engine error: ${err.message}\n`,
    }
  }
}

// ─── Fallback Report Builder ───────────────────────────────────────────

function buildFallbackReport(report, verbose) {
  const lines = []
  lines.push("\n" + "=".repeat(60))
  lines.push("  FlowDeck Doctor")
  lines.push(`  Version: ${report.version || "unknown"}`)
  lines.push(`  Profile: ${report.profile || "recommended-dev"}`)
  lines.push(`  Timestamp: ${report.timestamp || new Date().toISOString()}`)
  lines.push("=".repeat(60) + "\n")

  const s = report.summary || report
  const errors = s.errors || 0
  const warnings = s.warnings || 0

  lines.push(`  Errors: ${errors} | Warnings: ${warnings}`)
  lines.push("")

  if (report.checks) {
    for (const c of report.checks) {
      const icon = c.status === "pass" ? "OK" : c.status === "warning" ? "WARN" : "ERROR"
      lines.push(`  ${icon}  ${c.title || c.name}: ${c.detected || c.message || ""}`)
      if (verbose && c.recommendation) {
        lines.push(`       ${c.recommendation}`)
      }
    }
    lines.push("")
  }

  lines.push("=".repeat(60) + "\n")
  return lines.join("\n")
}
