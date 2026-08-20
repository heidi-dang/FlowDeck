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
import { existsSync } from "node:fs"
import { resolveDoctorExitCode } from "./exit-code.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, "..", "..")

// Resolve bun binary path once at module load
// Stored as a module-level value to avoid PATH issues in child processes
let BUN_BIN = null
function resolveBunBinary() {
  if (BUN_BIN !== null) return BUN_BIN
  const candidates = []
  if (process.env.FLOWDECK_BUN_BIN) candidates.push(process.env.FLOWDECK_BUN_BIN)
  if (typeof process !== "undefined" && process.versions?.bun && process.execPath) {
    candidates.push(process.execPath)
  }
  try {
    const homeOS = homedir()
    if (homeOS) candidates.push(join(homeOS, ".bun", "bin", "bun"), join(homeOS, ".bun", "bin", "bun.exe"))
  } catch {}
  const homeEnv = process.env.HOME || process.env.USERPROFILE || ""
  if (homeEnv) candidates.push(join(homeEnv, ".bun", "bin", "bun"), join(homeEnv, ".bun", "bin", "bun.exe"))
  candidates.push("/usr/local/bin/bun", "/usr/bin/bun", "bun", "bun.exe")

  
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
        shell: process.platform === "win32",
      })
      BUN_BIN = candidate
      return BUN_BIN
    } catch {}
  }
  BUN_BIN = false
  return BUN_BIN
}

// ─── Argument Parsing ──────────────────────────────────────────────────

function parseArgs(args) {
  const options = {
    json: false,
    strict: false,
    verbose: false,
    applyRecommended: false,
    fix: false,
    dryRun: false,
    profile: "recommended-dev",
    nonInteractive: false,
  }
  const unknown = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") {
      return { help: true }
    } else if (arg === "--json") {
      options.json = true
    } else if (arg === "--strict") {
      options.strict = true
    } else if (arg === "--verbose") {
      options.verbose = true
    } else if (arg === "--apply-recommended") {
      options.applyRecommended = true
    } else if (arg === "fix" || arg === "--fix") {
      options.fix = true;
      options.applyRecommended = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true
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

function runViaBunInline(options, entryPath) {
  const bunBin = resolveBunBinary()
  if (!bunBin) {
    throw new Error("Bun not available. Build the project first: bun run build")
  }

  const doctorSrcPath = join(PKG_ROOT, "src", "doctor", "doctor.ts")
  const distPath = join(PKG_ROOT, "dist", "index.js")
  const doctorPath = entryPath || (existsSync(doctorSrcPath) ? doctorSrcPath : distPath)
  // Ensure bun binary path is available to subprocesses
  const execEnv = { ...process.env, FLOWDECK_BUN_BIN: bunBin }

  // Use bun to import and execute the TypeScript or compiled module
  // bun handles TS-to-JS transpilation automatically
  const script = [
    `import * as doctorMod from ${JSON.stringify(doctorPath)};`,
    `const runFn = doctorMod.runDoctor || doctorMod.runDoctorChecks;`,
    `const targetDir = ${JSON.stringify(options?.directory || process.cwd())};
    const r = await runFn(targetDir, ${JSON.stringify(options)});`,
    `process.stdout.write("__FLOWDECK_DOCTOR_JSON_START__" + JSON.stringify(r) + "__FLOWDECK_DOCTOR_JSON_END__");`,
  ].join("\n")

  try {
    const output = execFileSync(bunBin, ["-e", script], {
      cwd: PKG_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: execEnv,
    })
    const match = output.match(/__FLOWDECK_DOCTOR_JSON_START__(.*)__FLOWDECK_DOCTOR_JSON_END__/s)
    if (match) {
      return JSON.parse(match[1])
    }
    return JSON.parse(output.trim())
  } catch (e) {
    const stderr = e.stderr || ""
    const stdout = e.stdout || ""
    // Try to parse JSON from stdout even on error
    try {
      const match = stdout.match(/__FLOWDECK_DOCTOR_JSON_START__(.*)__FLOWDECK_DOCTOR_JSON_END__/s)
      if (match) {
        return JSON.parse(match[1])
      }
      return JSON.parse(stdout.trim())
    } catch {
      // Extract meaningful error from stderr
      const stderrText = typeof stderr === "string" ? stderr.trim() : (stderr ? stderr.toString("utf-8").trim() : "")
      const errMsg = stderrText || e.message
      throw new Error(errMsg)
    }
  }
}

async function runDoctorEngine(options) {
  const doctorSrcPath = join(PKG_ROOT, "src", "doctor", "doctor.ts")
  const distPath = join(PKG_ROOT, "dist", "index.js")

  // Try 1: Run via bun in dev mode (if bun is available AND doctor.ts source exists)
  if (hasBun() && existsSync(doctorSrcPath)) {
    try {
      return runViaBunInline(options, doctorSrcPath)
    } catch {
      // Fall through
    }
  }

  // Try 2: Compiled dist (packaged npm install or built dist)
  if (existsSync(distPath)) {
    try {
      const distUrl = pathToFileURL(distPath).href
      const mod = await import(distUrl)
      const runFn = mod.runDoctor || mod.runDoctorChecks
      if (typeof runFn === "function") {
        const targetDir = options?.directory || process.cwd();
        return await runFn(targetDir, options)
      }
    } catch {
      // Fall through to bun inline if ESM import fails
    }
    if (hasBun()) {
      try {
        return runViaBunInline(options, distPath)
      } catch {
        // Fall through
      }
    }
  }

  throw new Error(
    "Doctor engine not available. Install bun or build the project: bun run build"
  )
}

// ─── Secret Redaction ──────────────────────────────────────────────────

const SECRET_KEY_PATTERNS = /api[_-]?key|token|secret|password|credential|auth/i

function redactSecrets(obj, seen = new WeakSet(), depth = 0) {
  if (depth > 50) return "[MAX_DEPTH]"
  if (typeof obj === "string") {
    return obj
  }
  if (Array.isArray(obj)) {
    if (seen.has(obj)) return "[CIRCULAR]"
    seen.add(obj)
    return obj.map(item => redactSecrets(item, seen, depth + 1))
  }
  if (obj && typeof obj === "object") {
    if (seen.has(obj)) return "[CIRCULAR]"
    seen.add(obj)
    const redacted = {}
    try {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && value.length > 0 && value.length < 500) {
          if (SECRET_KEY_PATTERNS.test(key)) {
            redacted[key] = "[REDACTED]"
            continue
          }
        }
        redacted[key] = redactSecrets(value, seen, depth + 1)
      }
    } catch {
      return "[UNSERIALIZABLE]"
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
  const HELP_TEXT = `FlowDeck Doctor — Environment Health Checker

Usage: doctor [--json] [--strict] [--verbose] [--apply-recommended] [--profile <name>] [--non-interactive] [--help]

Options:
  --json               Output machine-readable JSON to stdout
  --strict             Treat warnings as failures
  --verbose            Include detailed check output
  --apply-recommended  Apply safe auto-fixes
  --profile <name>     Check profile (default: recommended-dev)
  --non-interactive    Disable interactive prompts
  --help               Show this help message
`
  // Strip optional "doctor" prefix if present
  const args = rawArgs[0] === "doctor" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseArgs(args);

  if (parsed.help) {
    process.stderr.write(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    if (parsed.usage) {
      process.stderr.write(`${parsed.usage}\n`);
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
    
    process.exitCode = resolveDoctorExitCode(report, !!options.strict);
  } catch (err) {
    process.stderr.write(`Doctor engine error: ${err.message}\n`);
    process.exitCode = 2;
  }
}

async function main() {
  await runDoctorCli(process.argv.slice(2));
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

// Only run main() when this file is the direct entry point.
// Importing the module for its exports (e.g., runDoctorCli) must not trigger execution.
// Guard against undefined process.argv[1] (e.g., in node -e contexts).
const isDirectEntry =
  typeof process.argv[1] === "string" &&
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectEntry) {
  await main()
}
