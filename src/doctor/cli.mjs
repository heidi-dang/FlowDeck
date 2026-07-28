#!/usr/bin/env node
/**
 * src/doctor/cli.mjs — Standalone doctor CLI
 *
 * Entry point for the FlowDeck Environment Doctor, callable as:
 *   node src/doctor/cli.mjs [options]
 *
 * Resolves the doctor engine from:
 *   1. Compiled dist/index.js (packaged npm install)
 *   2. TypeScript source via bun (development)
 *
 * Output formats:
 *   Human-readable text to stdout (default)
 *   JSON only to stdout (--json), diagnostics/stderr sent to stderr
 *
 * Exit codes:
 *   0 — healthy, warnings allowed in normal mode, safe fixes completed
 *   1 — required checks failed, strict-mode policy failure, fix failures
 *   2 — invalid arguments, internal engine error, malformed profile/contract
 */

import { resolve, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, "..", "..")

// Resolve bun binary path once at module load
// Stored as a module-level value to avoid PATH issues in child processes
let BUN_BIN = null
function resolveBunBinary() {
  if (BUN_BIN !== null) return BUN_BIN
  // Check if FLOWDECK_BUN_BIN env variable was passed explicitly by parent process
  if (process.env.FLOWDECK_BUN_BIN) {
    BUN_BIN = process.env.FLOWDECK_BUN_BIN
    return BUN_BIN
  }
  // Try finding bun in PATH
  try {
    execFileSync("bun", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "ignore",
    })
    BUN_BIN = "bun"
  } catch {
    BUN_BIN = false
  }
  return BUN_BIN
}

// ─── Argument Parsing ──────────────────────────────────────────────────

function parseArgs(args) {
  const options = {
    json: false,
    strict: false,
    verbose: false,
    applyRecommended: false,
    profile: "recommended-dev",
    nonInteractive: false,
  }
  const unknown = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--json") {
      options.json = true
    } else if (arg === "--strict") {
      options.strict = true
    } else if (arg === "--verbose") {
      options.verbose = true
    } else if (arg === "--apply-recommended") {
      options.applyRecommended = true
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true
    } else if (arg === "--profile") {
      i++
      if (i >= args.length) {
        return { error: "--profile requires a value", exitCode: 2 }
      }
      options.profile = args[i]
    } else if (arg.startsWith("--")) {
      unknown.push(arg)
    } else {
      return { error: `Unexpected argument: ${arg}`, exitCode: 2 }
    }
  }

  if (unknown.length > 0) {
    return {
      error: `Unknown flags: ${unknown.join(", ")}`,
      exitCode: 2,
      usage: `Usage: doctor [--json] [--strict] [--verbose] [--apply-recommended] [--profile <name>] [--non-interactive]`,
    }
  }

  return { options }
}

// ─── Doctor Engine Resolution ──────────────────────────────────────────

function hasBun() {
  return resolveBunBinary() !== false
}

function runViaBunInline(options) {
  const bunBin = resolveBunBinary()
  if (!bunBin) {
    throw new Error("Bun not available. Build the project first: bun run build")
  }

  const doctorPath = join(PKG_ROOT, "src/doctor/doctor.ts")
  // Ensure bun binary path is available to subprocesses
  const execEnv = { ...process.env, FLOWDECK_BUN_BIN: bunBin }
  const opts = {
    directory: PKG_ROOT,
    options: {
      json: false,
      strict: !!options.strict,
      verbose: !!options.verbose,
      applyRecommended: !!options.applyRecommended,
      profile: options.profile || "recommended-dev",
      nonInteractive: !!options.nonInteractive,
    },
  }

  // Use bun to import and execute the TypeScript module
  // bun handles TS-to-JS transpilation automatically
  const script = [
    `import { runDoctor, formatReport, formatJSON } from ${JSON.stringify(doctorPath)};`,
    `const r = await runDoctor(${JSON.stringify(PKG_ROOT)}, ${JSON.stringify(opts.options)});`,
    `process.stdout.write(JSON.stringify(r));`,
  ].join("\n")

  try {
    const output = execFileSync(bunBin, ["-e", script], {
      cwd: PKG_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: execEnv,
    })
    const trimmed = output.trim()
    return JSON.parse(trimmed)
  } catch (e) {
    const stderr = e.stderr || ""
    const stdout = e.stdout || ""
    // Try to parse JSON from stdout even on error
    try {
      return JSON.parse(stdout.trim())
    } catch {
      // Extract meaningful error from stderr
      const errMsg = stderr ? stderr.trim().split("\n").pop() : e.message
      throw new Error(errMsg)
    }
  }
}

async function runDoctorEngine(options) {
  // Try 1: Run via bun (development mode — faster iteration)
  if (hasBun()) {
    return runViaBunInline(options)
  }

  // Try 2: Compiled dist (packaged npm install)
  const { existsSync } = await import("node:fs")
  const distPath = join(PKG_ROOT, "dist", "index.js")
  if (existsSync(distPath)) {
    try {
      const distUrl = pathToFileURL(distPath).href
      const mod = await import(distUrl)
      if (typeof mod.runDoctor === "function") {
        return await mod.runDoctor(PKG_ROOT, options)
      }
    } catch {
      // Fall through
    }
  }

  throw new Error(
    "Doctor engine not available. Install bun or build the project: bun run build"
  )
}

// ─── Secret Redaction ──────────────────────────────────────────────────

const SECRET_KEY_PATTERNS = /api[_-]?key|token|secret|password|credential|auth/i

function redactSecrets(obj) {
  if (typeof obj === "string") {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(redactSecrets)
  }
  if (obj && typeof obj === "object") {
    const redacted = {}
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && value.length > 0 && value.length < 500) {
        if (SECRET_KEY_PATTERNS.test(key)) {
          redacted[key] = "[REDACTED]"
          continue
        }
      }
      redacted[key] = redactSecrets(value)
    }
    return redacted
  }
  return obj
}

// ─── Report Formatting ─────────────────────────────────────────────────

function buildHumanReport(report, verbose) {
  const lines = []

  // Schema header
  lines.push("")
  lines.push("=".repeat(60))
  lines.push("  FlowDeck Environment Doctor")
  lines.push(`  Version: ${report.version || "unknown"}`)
  lines.push(`  Profile: ${report.profile || "recommended-dev"}`)
  lines.push(`  Timestamp: ${report.timestamp || new Date().toISOString()}`)
  lines.push("=".repeat(60))
  lines.push("")

  // Summary
  const s = report.summary || {}
  const total = s.total || 0
  const passed = s.passed || 0
  const warnings = s.warnings || 0
  const errors = s.errors || 0
  const info = s.info || 0
  const skipped = s.skipped || 0

  lines.push(`  Checks: ${total} total | ${passed} passed | ${warnings} warnings | ${errors} errors | ${info} info | ${skipped} skipped`)
  lines.push("")

  // Scores
  const scores = report.scores || {}
  lines.push("  Scores:")
  lines.push(`    Environment: ${scores.environment ?? "?"}/100`)
  lines.push(`    Security:    ${scores.security ?? "?"}/100`)
  lines.push(`    Performance: ${scores.performance ?? "?"}/100`)
  lines.push(`    Config:      ${scores.configuration ?? "?"}/100`)
  lines.push(`    ─────────────────────`)
  lines.push(`    Overall:     ${scores.overall ?? "?"}/100`)
  lines.push("")

  // Readiness
  const overall = scores.overall ?? 0
  const readiness = overall >= 90 ? "Production Ready"
    : overall >= 70 ? "Mostly Ready"
    : overall >= 50 ? "Needs Work"
    : "Not Ready"
  lines.push(`  Readiness: ${readiness}`)
  lines.push("")

  // Errors (always shown)
  const errorsList = (report.checks || []).filter(c => c.status === "error")
  if (errorsList.length > 0) {
    lines.push("  [Errors]")
    for (const c of errorsList) {
      lines.push(`    ERROR  ${c.title || c.name}: ${c.detected || c.message}`)
      if (c.recommendation || c.remediation) {
        lines.push(`           ${c.recommendation || c.remediation}`)
      }
      if (c.autoFixAvailable) lines.push("           Auto-fix available")
      lines.push("")
    }
  }

  // Warnings
  if (verbose || errorsList.length === 0) {
    const warningsList = (report.checks || []).filter(c => c.status === "warning")
    if (warningsList.length > 0) {
      lines.push("  [Warnings]")
      for (const c of warningsList) {
        lines.push(`    WARN   ${c.title || c.name}: ${c.detected || c.message}`)
        if (verbose && c.recommendation) {
          lines.push(`           ${c.recommendation}`)
        }
        lines.push("")
      }
    }
  }

  // Info for verbose
  if (verbose) {
    const infoList = (report.checks || []).filter(c => c.status === "info" || c.status === "pass")
    if (infoList.length > 0) {
      lines.push("  [Details]")
      for (const c of infoList.slice(0, 20)) {
        lines.push(`    ${c.status === "pass" ? "OK" : "INFO"}     ${c.title || c.name}: ${c.detected || c.message || c.expected}`)
      }
      if (infoList.length > 20) {
        lines.push(`    ... and ${infoList.length - 20} more`)
      }
      lines.push("")
    }
  }

  // Recommendations
  const recommendations = report.recommendations || []
  if (recommendations.length > 0) {
    lines.push("  [Recommendations]")
    for (const r of recommendations) {
      const icon = r.type === "required" ? "REQUIRED" : r.type === "recommended" ? "RECOMMENDED" : "OPTIONAL"
      lines.push(`    ${icon}  ${r.title}`)
      lines.push(`           ${r.description}`)
      if (r.autoFixAvailable) lines.push(`           Auto-fix: ${r.autoFixCommand || "available"}`)
      lines.push("")
    }
  }

  lines.push("=".repeat(60))
  lines.push("")

  return lines.join("\n")
}

// ─── Main ──────────────────────────────────────────────────────────────

export async function runDoctorCli(rawArgs) {
  // Strip optional "doctor" prefix if present
  const args = rawArgs[0] === "doctor" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseArgs(args);
  
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}
`);
    if (parsed.usage) {
      process.stderr.write(`${parsed.usage}
`);
    }
    process.exitCode = parsed.exitCode;
    return;
  }
  
  const { options } = parsed;
  
  try {
    let report = await runDoctorEngine(options);
    report = redactSecrets(report);
    
    if (options.json) {
      const jsonOutput = JSON.stringify({ schemaVersion: 1, ...report }, null, 2);
      process.stdout.write(jsonOutput + "\n");
    } else {
      const textOutput = buildHumanReport(report, options.verbose);
      process.stdout.write(textOutput);
    }
    
    const errors = (report.summary && report.summary.errors) || 0;
    if (options.strict) {
      const criticals = (report.checks || []).filter(c =>
        c.status === "error" || c.severity === "critical" || c.severity === "high"
      );
      process.exitCode = criticals.length > 0 ? 1 : 0;
    } else if (errors > 0) {
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  } catch (err) {
    process.stderr.write(`Doctor engine error: ${err.message}\n`);
    process.exitCode = 2;
  }
}

async function main() {
  // Strip optional "doctor" command prefix
  const rawArgs = process.argv.slice(2)
  const cliArgs = rawArgs[0] === "doctor" ? rawArgs.slice(1) : rawArgs
  const parsed = parseArgs(cliArgs)

  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n`)
    if (parsed.usage) {
      process.stderr.write(`${parsed.usage}\n`)
    }
    process.exit(parsed.exitCode)
  }

  const { options } = parsed

  try {
    let report = await runDoctorEngine(options)

    // Redact secrets
    report = redactSecrets(report)

    // Apply schema version for JSON output
    if (options.json) {
      const jsonOutput = JSON.stringify({ schemaVersion: 1, ...report }, null, 2)
      process.stdout.write(jsonOutput + "\n")
    } else {
      const textOutput = buildHumanReport(report, options.verbose)
      process.stdout.write(textOutput)
    }

    // Determine exit code
    const errors = (report.summary && report.summary.errors) || 0

    if (options.strict) {
      // Strict mode: any error or high/critical severity fails
      const criticals = (report.checks || []).filter(c =>
        c.status === "error" || c.severity === "critical" || c.severity === "high"
      )
      if (criticals.length > 0) {
        process.exit(1)
      }
    } else if (errors > 0) {
      process.exit(1)
    }

    process.exit(0)
  } catch (err) {
    process.stderr.write(`Doctor engine error: ${err.message}\n`)
    process.exit(2)
  }
}

// Only run main() when this file is the direct entry point.
// Importing the module for its exports (e.g., runDoctorCli) must not trigger execution.
const { pathToFileURL: _ptfu } = await import("node:url")
if (import.meta.url === _ptfu(process.argv[1]).href) {
  main()
}
