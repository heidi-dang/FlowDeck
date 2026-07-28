#!/usr/bin/env node
/**
 * scripts/ci-doctor-smoke.mjs — CI Doctor Smoke Test
 *
 * Validates that the doctor CLI:
 *   - Exits with 0 or 1 (valid completed diagnostic)
 *   - Rejects exit code 2+ (internal error / invalid args)
 *   - Outputs valid JSON with schemaVersion === 1
 *   - Contains a summary object and checks array
 *   - Does not contaminate JSON stdout with human diagnostics
 *
 * Uses an isolated temporary HOME and OPENCODE_CONFIG_DIR.
 * Designed as a single reusable CI gate so every CI caller agrees
 * on the exit-code contract without duplicating logic.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const SCRIPT = 2
const CLI_PATH = new URL("../bin/flowdeck.js", import.meta.url).pathname

function main() {
  const tmpHome = join(tmpdir(), `fd-ci-doctor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const configDir = join(tmpHome, ".config", "opencode")

  try {
    mkdirSync(configDir, { recursive: true })

    const env = {
      ...process.env,
      HOME: tmpHome,
      OPENCODE_CONFIG_DIR: configDir,
      // Ensure bun binary is findable from child processes
      FLOWDECK_BUN_BIN: process.env.FLOWDECK_BUN_BIN || "",
    }

    // Run doctor with JSON output
    let stdout, stderr, status
    try {
      const proc = execFileSync(
        "node",
        [CLI_PATH, "doctor", "--json", "--profile", "ci", "--non-interactive"],
        {
          cwd: new URL("..", import.meta.url).pathname,
          env,
          encoding: "utf-8",
          timeout: 60000,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
        },
      )
      stdout = proc?.toString?.() ?? proc ?? ""
      status = 0
      stderr = ""
    } catch (e) {
      status = e.status ?? 1
      stdout = e.stdout?.toString?.() ?? ""
      stderr = e.stderr?.toString?.() ?? ""
    }

    // Exit-code contract: 0 or 1 = valid completed diagnostic, 2+ = failure
    if (status >= SCRIPT) {
      const msg = stderr || stdout.slice(0, 500) || `Doctor exited with code ${status}`
      console.error(`FAIL: Doctor returned exit code ${status} (expected 0 or 1)`)
      console.error(`  stderr: ${msg.slice(0, 500)}`)
      process.exit(1)
    }

    // Validate stdout is parseable JSON
    let report
    try {
      report = JSON.parse(stdout.trim())
    } catch {
      // If stdout isn't JSON, it might be human-readable output (text mode fallback)
      // Check if there's diagnostic content
      const humanOutput = stdout.trim()
      if (humanOutput.includes("FlowDeck") || humanOutput.includes("Doctor") || humanOutput.includes("ERROR") || humanOutput.includes("Checks")) {
        // Human-readable output without --json? Try running with --json explicitly
        console.error("FAIL: Doctor output is human-readable, not JSON. Did --json flag work?")
        console.error(`  stdout (first 500): ${humanOutput.slice(0, 500)}`)
        process.exit(1)
      }
      console.error(`FAIL: Doctor stdout is not valid JSON: ${stdout.trim().slice(0, 200)}`)
      process.exit(1)
    }

    // schemaVersion must be 1
    if (report.schemaVersion !== 1) {
      console.error(`FAIL: schemaVersion is ${report.schemaVersion}, expected 1`)
      process.exit(1)
    }

    // Must have summary object
    if (!report.summary || typeof report.summary !== "object") {
      console.error("FAIL: Missing or invalid summary object")
      process.exit(1)
    }

    // Must have checks array
    if (!Array.isArray(report.checks)) {
      console.error("FAIL: Missing or invalid checks array")
      process.exit(1)
    }

    // Must have scores object
    if (!report.scores || typeof report.scores !== "object") {
      console.error("FAIL: Missing or invalid scores object")
      process.exit(1)
    }

    // stderr must not contain the JSON output
    if (stderr && stderr.trim()) {
      try {
        JSON.parse(stderr.trim())
        // stderr is parseable as JSON — bad, diagnostics should not be valid JSON
        console.error("FAIL: stderr contains parseable JSON (diagnostics must not be JSON)")
        process.exit(1)
      } catch {
        // stderr not JSON — good, but check it doesn't contain schemaVersion
        if (stderr.includes("schemaVersion")) {
          console.error("FAIL: stderr contains schemaVersion (diagnostics leaking JSON)")
          process.exit(1)
        }
      }
    }

    // Success
    const errs = report.summary.errors ?? 0
    const warns = report.summary.warnings ?? 0
    const total = report.summary.total ?? report.checks.length
    console.log(`PASS: Doctor smoke check — schemaVersion=${report.schemaVersion}, ${total} checks, ${errs} errors, ${warns} warnings, exit=${status}`)
  } finally {
    // Clean up isolated temp directory
    try {
      rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

main()
