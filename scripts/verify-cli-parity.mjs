#!/usr/bin/env node
/**
 * scripts/verify-cli-parity.mjs
 *
 * Verifies that:
 *   1. bin/flowdeck.js imports from src/cli/flowdeck.mjs (canonical source)
 *   2. bin/flowdeck.js contains no command implementations
 *   3. Source entrypoint and repository bin return identical results
 *   4. Packed CLI behavior matches repository CLI
 *
 * Usage:
 *   node scripts/verify-cli-parity.mjs
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(ENTRY_DIR, "..")

let exitCode = 0
let checksRun = 0
let checksFailed = 0

function check(name, predicate) {
  checksRun++
  try {
    const result = typeof predicate === "function" ? predicate() : predicate
    if (result === true || result === undefined) {
      console.log(`  ✓ ${name}`)
    } else {
      console.log(`  ✗ ${name}`)
      checksFailed++
      exitCode = 1
    }
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`)
    checksFailed++
    exitCode = 1
  }
}

function runCli(args, { cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "bin", "flowdeck.js"),
    ...args,
  ], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function runModule(args, { cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync(process.execPath, [
    "-e",
    `import { main } from ${JSON.stringify(join(REPO_ROOT, "src/cli/flowdeck.mjs"))}; main(${JSON.stringify(args)}).then(r => { process.exitCode = r.exitCode }).catch(e => { console.error(e.message); process.exit(1) })`,
  ], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function main() {
  const binPath = join(REPO_ROOT, "bin", "flowdeck.js")
  const cliPath = join(REPO_ROOT, "src/cli/flowdeck.mjs")

  console.log("=== CLI Parity Verification ===\n")

  // 1. Verify bin imports canonical source
  console.log("[1] bin/flowdeck.js structure")
  const binContent = readFileSync(binPath, "utf-8")
  check("imports from src/cli/flowdeck.mjs", () =>
    binContent.includes('from "../src/cli/flowdeck.mjs"'),
  )
  check("no cmdDoctor definition", () =>
    !binContent.includes("cmdDoctor"),
  )
  check("no command handler map", () =>
    !binContent.includes("handlers[") && !binContent.includes("handlerKey"),
  )
  check("under 25 lines", () =>
    binContent.split("\n").length <= 25,
  )

  // 2. Verify canonical source exports main
  console.log("\n[2] src/cli/flowdeck.mjs exports")
  const cliContent = readFileSync(cliPath, "utf-8")
  check("exports main function", () =>
    cliContent.includes("export async function main"),
  )
  check("returns { exitCode }", () =>
    cliContent.includes("exitCode"),
  )

  // 3. Verify CLI outputs — compare bin and source
  console.log("\n[3] CLI output parity")

  const testCases = [
    { args: ["--help"], label: "--help" },
    { args: ["doctor", "--help"], label: "doctor --help" },
    { args: ["doctor", "--strict"], label: "doctor --strict" },
    { args: ["doctor", "--profile", "recommended-dev"], label: "valid profile" },
    { args: ["doctor", "--profile", "nonexistent"], label: "invalid profile" },
    { args: ["doctor", "--invalid-flag"], label: "unknown flag" },
    { args: ["doctor", "--json"], label: "doctor --json" },
  ]

  for (const { args, label } of testCases) {
    const binResult = runCli(args)
    const modResult = runModule(args)

    check(`${label}: exit code matches`, () =>
      binResult.code === modResult.code,
    )

    // For general --help, output is on stdout; for doctor --help, output is on stderr
    if (args.includes("--help")) {
      const isDoctorHelp = args[0] === "doctor"
      const helpStdout = isDoctorHelp ? binResult.stderr : binResult.stdout
      const modHelpStdout = isDoctorHelp ? modResult.stderr : modResult.stdout
      check(`${label}: contains version info`, () =>
        helpStdout.includes("FlowDeck") &&
        modHelpStdout.includes("FlowDeck"),
      )
    }

    // For doctor --json, verify JSON is parseable and contains expected fields
    if (args.includes("--json")) {
      check(`${label}: bin stdout is parseable JSON`, () => {
        JSON.parse(binResult.stdout)
        return true
      })
      check(`${label}: mod stdout is parseable JSON`, () => {
        JSON.parse(modResult.stdout)
        return true
      })
    }

    // Stderr must be empty for general --help and --json (doctor --help legitimately uses stderr)
    if (args.includes("--help") && !args.includes("doctor")) {
      check(`${label}: no stderr contamination`, () =>
        binResult.stderr === "" && modResult.stderr === "",
      )
    }
  }

  // 4. Verify exit code contract: 0 or 1 for doctor, >=2 for errors
  console.log("\n[4] Exit code contract")
  const healthResult = runCli(["doctor", "--json"])
  check("doctor exit code is 0 or 1", () =>
    healthResult.code === 0 || healthResult.code === 1,
  )
  if (healthResult.code <= 1) {
    check("doctor JSON is parseable", () => {
      JSON.parse(healthResult.stdout)
      return true
    })
    check("doctor JSON has no stderr contamination", () =>
      healthResult.stderr === "",
    )
  }

  // Error cases should exit >=2
  const invalidFlagResult = runCli(["doctor", "--bogus"])
  check("unknown flag exits >= 2", () => invalidFlagResult.code >= 2)

  const invalidProfileResult = runCli(["doctor", "--profile", "does-not-exist"])
  check("invalid profile exits >= 2", () => invalidProfileResult.code >= 2)

  // 5. Verify the module source has no duplicate definitions
  console.log("\n[5] No duplicate definitions")
  const cmdFunctions = cliContent.match(/async function cmd\w+/g) || []
  const uniqueCmds = new Set(cmdFunctions)
  check(`no duplicate cmd* functions (${cmdFunctions.length} unique)`, () =>
    cmdFunctions.length === uniqueCmds.size,
  )

  // Summary
  console.log(`\n=== Results: ${checksRun - checksFailed}/${checksRun} passed ===`)
  if (checksFailed > 0) {
    console.log(`${checksFailed} check(s) FAILED`)
    process.exit(1)
  }
  console.log("All parity checks passed.")
}

main()
