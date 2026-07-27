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
      timeout: 5000,
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

function runViaBun(directory, options = {}) {
  // Use bun to import and execute the TypeScript doctor module inline
  const doctorPath = join(PKG_ROOT, "src/doctor/doctor.ts")
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
    `process.stdout.write(JSON.stringify(r));`,
  ].join("\n")

  try {
    const output = execFileSync(bunBin(), ["-e", script], {
      cwd: PKG_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return JSON.parse(output.trim())
  } catch (e) {
    const stderr = e.stderr || ""
    const stdout = e.stdout || ""
    // Try to parse JSON from stdout even on error
    try {
      return JSON.parse(stdout.trim())
    } catch {
      if (stderr) {
        throw new Error(stderr.trim().split("\n").pop() || e.message)
      }
      throw e
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────

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

// ─── Fallback Report Builder ───────────────────────────────────────────

function buildFallbackReport(report, verbose) {
  const lines = []
  lines.push("\n" + "=".repeat(60))
  lines.push("  FlowDeck Environment Doctor")
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
