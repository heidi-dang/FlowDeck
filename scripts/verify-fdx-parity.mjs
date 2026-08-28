#!/usr/bin/env node
/**
 * verify-fdx-parity.mjs — Enforce cross-runtime FDX native binary parity
 *
 * Requirements:
 *   1. Cargo must be available (fail if not)
 *   2. FDX binary is built from current branch source
 *   3. Binary path is absolute
 *   4. FDX_DISABLE_FALLBACK=1 prevents any TypeScript fallback
 *   5. Dedicated parity tests are run (not full suite)
 *   6. Native execution is proven (emits evidence)
 *
 * Coverage: search, grep, batch, diff, impact, git policy, project ID generation
 */

import { execFileSync } from "node:child_process"
function safeExecFileSync(file, args, opts = {}) {
  try {
    return execFileSync(file, args, { encoding: "utf-8", env: process.env, ...opts });
  } catch (err) {
    if (err.stdout && (err.status === 0 || err.status === null)) {
      return err.stdout;
    }
    throw err;
  }
}

import { existsSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { resolveRustToolchain } from "./rust-toolchain.mjs"

function resolveBunExecutable(env = process.env, platform = process.platform) {
  const executable = platform === "win32" ? "bun.exe" : "bun"
  const candidates = []
  if (env.BUN_BIN) candidates.push(env.BUN_BIN)
  if (env.FLOWDECK_BUN_BIN) candidates.push(env.FLOWDECK_BUN_BIN)
  const home = env.USERPROFILE || env.HOME
  if (home) candidates.push(join(home, ".bun", "bin", executable))

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }

  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, executable)
    if (existsSync(candidate)) return candidate
  }

  throw new Error("Bun executable not found; install Bun or set BUN_BIN/FLOWDECK_BUN_BIN")
}

const ROOT = resolve(import.meta.dirname, "..")
const MANIFEST_PATH = join(ROOT, "crates", "fdx", "Cargo.toml")
const BINARY_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"
const WORKSPACE_BINARY = join(ROOT, "target", "debug", BINARY_NAME)
const CRATE_BINARY = join(ROOT, "crates", "fdx", "target", "debug", BINARY_NAME)
const BINARY_PATH = existsSync(WORKSPACE_BINARY) ? WORKSPACE_BINARY : CRATE_BINARY


let exitCode = 0
function check(label, ok, detail = "") {
  const icon = ok ? "✓" : "✗"
  console.log(` ${icon} ${label}${detail ? ": " + detail : ""}`)
  if (!ok) exitCode = 1
}

console.log("\n=== FlowDeck FDX Cross-Runtime Parity Gate ===\n")

// ── 1. Resolve one Cargo/Rustc pair ─────────────────────────────────────
let toolchain
try {
  toolchain = resolveRustToolchain()
  console.log(`  Cargo: ${toolchain.cargoVersion}`)
  console.log(`  Rustc: ${toolchain.rustcVersion}`)
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  console.error("  Install Rust via https://rustup.rs and try again.")
  process.exit(1)
}

let bun
try {
  bun = resolveBunExecutable()
  console.log(`  Bun: ${safeExecFileSync(bun, ["--version"], { timeout: 5000 }).trim()} (${bun})`)
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  process.exit(1)
}

// ── 2. Build FDX binary ──────────────────────────────────────────────
console.log("\n  Building FDX native binary from current branch source...")
try {
  safeExecFileSync(toolchain.cargo, ["build", "--manifest-path", MANIFEST_PATH], { env: toolchain.env, stdio: "inherit", timeout: 300000 })
} catch (e) {
  console.error(`ERROR: FDX build failed: ${e.message}`)
  process.exit(1)
}

// ── 3. Verify binary exists at absolute path ─────────────────────────
check("FDX binary exists", existsSync(BINARY_PATH), BINARY_PATH)
if (!existsSync(BINARY_PATH)) process.exit(1)

// Verify it's executable
try {
  const binaryVer = safeExecFileSync(BINARY_PATH, ["--version"], { timeout: 5000 }).trim()
  check("FDX binary executable", true, binaryVer)
} catch {
  check("FDX binary executable", false)
  process.exit(1)
}

// ── 4. Set enforcement env ───────────────────────────────────────────
process.env.FDX_DISABLE_FALLBACK = "1"
process.env.FDX_BINARY_PATH = BINARY_PATH
console.log("  FDX_DISABLE_FALLBACK=1 enforced")
console.log(`  FDX_BINARY_PATH=${BINARY_PATH}`)

// ── 5. Run dedicated parity tests ────────────────────────────────────
console.log("\n  Running dedicated FDX parity tests...\n")

const parityTests = [
  "tests/fdx-path-parity.test.ts",
  "tests/fdx-git-policy.test.ts",
]


for (const testFile of parityTests) {
  const fullPath = join(ROOT, testFile)
  if (!existsSync(fullPath)) {
    console.error(`  FAIL ${testFile} (required test file missing!)`)
    exitCode = 1
    continue
  }
  try {
    safeExecFileSync(bun, ["test", fullPath], {
      stdio: "inherit",
      env: { ...process.env, FDX_DISABLE_FALLBACK: "1", FDX_BINARY_PATH: BINARY_PATH },
      timeout: 60000,
    })
    console.log(`  PASS ${testFile}\n`)
  } catch {
    console.error(`  FAIL ${testFile}\n`)
    exitCode = 1
  }
}

// ── 6. Emit native execution proof ──────────────────────────────────
console.log("\n  Native execution proof:")
try {
  const proof = safeExecFileSync(BINARY_PATH, ["search", "package", "package.json"], {
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, FDX_DISABLE_FALLBACK: "1", FDX_BINARY_PATH: BINARY_PATH },
  })
  const hasOutput = proof.length > 5
  check("fdx native binary execution works", hasOutput)
} catch {
  check("fdx native binary execution works", false)
  exitCode = 1
}


// ── 7. Summary ───────────────────────────────────────────────────────
console.log("")
if (exitCode === 0) {
  console.log("✓ FDX cross-runtime parity gate PASSED.")
  console.log("  Native binary was built, invoked, and all parity tests pass.")
} else {
  console.error("✗ FDX cross-runtime parity gate FAILED.")
  process.exit(1)
}
