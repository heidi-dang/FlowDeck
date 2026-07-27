/**
 * Pre-push validation gate.
 *
 * NOTE: This script is a fast local pre-push gate. GitHub Actions CI remains
 * the authoritative release gate.
 *
 * Runs local pre-push checks before pushing to remote:
 *   1. Lint (npm run lint)
 *   2. Typecheck (npm run typecheck)
 *   3. Test (npm test)
 *   4. Skill Validation (npm run validate:skills)
 *   5. Doc Validation (npm run validate:docs)
 *   6. Git Diff Whitespace Check (git diff --check)
 *   7. Package Dry Run (npm pack --dry-run)
 *   8. Build (npm run build)
 *   9. Rust Gates (conditional when crates/fdx/ changes; fails if Cargo missing)
 *
 * Usage:
 *   node scripts/pre-push.mjs
 *
 * Installation as Git Hook:
 *   Create .git/hooks/pre-push with contents:
 *     #!/bin/sh
 *     exec node scripts/pre-push.mjs "$@"
 *   and ensure executable permissions (chmod +x .git/hooks/pre-push on Unix/macOS).
 */

import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

/**
 * Robust detection of Rust file changes under crates/fdx/.
 * Order of checks:
 *   1. Working tree status (staged or unstaged)
 *   2. Upstream branch (@{u}) merge-base vs HEAD
 *   3. origin/HEAD merge-base vs HEAD
 *   4. Safe fallback: return true if git comparison cannot be established cleanly.
 */
export function detectRustChanges(cwd = root) {
  try {
    // 1. Inspect uncommitted working tree or staged changes
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" })
    const hasWorkingTreeRustChange = status.split("\n").some((line) => {
      const file = line.slice(3).trim()
      return file.startsWith("crates/fdx/")
    })
    if (hasWorkingTreeRustChange) return true

    // 2. Try configured upstream branch (@{u}) merge-base vs HEAD
    try {
      const upstream = execSync("git rev-parse --abbrev-ref @{u}", { cwd, encoding: "utf-8" }).trim()
      if (upstream) {
        const mergeBase = execSync(`git merge-base "${upstream}" HEAD`, { cwd, encoding: "utf-8" }).trim()
        const diffUpstream = execSync(`git diff --name-only "${mergeBase}" HEAD`, { cwd, encoding: "utf-8" })
        return diffUpstream.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
      }
    } catch {
      // Upstream branch not configured or unreachable
    }

    // 3. Try origin/HEAD merge-base vs HEAD
    try {
      const mergeBaseOrigin = execSync('git merge-base "origin/HEAD" HEAD', { cwd, encoding: "utf-8" }).trim()
      const diffOrigin = execSync(`git diff --name-only "${mergeBaseOrigin}" HEAD`, { cwd, encoding: "utf-8" })
      return diffOrigin.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
    } catch {
      // origin/HEAD unavailable
    }

    // 4. Safe fallback: if repository directory exists but upstream comparison failed, return true
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" })
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

const steps = [
  { name: "Lint", cmd: "npm run lint" },
  { name: "Typecheck", cmd: "npm run typecheck" },
  { name: "Test", cmd: "npm test" },
  { name: "Skill Validation", cmd: "npm run validate:skills" },
  { name: "Doc Validation", cmd: "npm run validate:docs" },
  { name: "Git Diff Check", cmd: "git diff --check" },
  { name: "Package Dry Run", cmd: "npm pack --dry-run" },
  { name: "Build", cmd: "npm run build" },
]

const rustChanged = detectRustChanges()

if (rustChanged) {
  let hasCargo = false
  try {
    execSync("cargo --version", { stdio: "ignore" })
    hasCargo = true
  } catch {
    hasCargo = false
  }

  if (!hasCargo) {
    console.error("\n✗ Rust files under crates/fdx/ have changed (or comparison could not be verified), but Cargo is not installed on PATH. Push blocked.")
    process.exit(1)
  }

  const manifestPath = "crates/fdx/Cargo.toml"
  steps.push(
    { name: "Rust Formatting", cmd: `cargo fmt --manifest-path ${manifestPath} --check` },
    { name: "Rust Clippy", cmd: `cargo clippy --manifest-path ${manifestPath} --all-targets -- -D warnings` },
    { name: "Rust Tests", cmd: `cargo test --manifest-path ${manifestPath} --all` },
    { name: "Rust Build", cmd: `cargo build --manifest-path ${manifestPath}` }
  )
} else {
  console.log("\n(No files under crates/fdx/ changed; local Rust gates skipped)")
}

let failed = false

for (const { name, cmd } of steps) {
  console.log(`\n── ${name} ──`)
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" })
  } catch {
    console.error(`\n✗ ${name} failed. Push blocked.`)
    failed = true
    break
  }
}

if (failed) {
  process.exit(1)
} else {
  console.log("\n✓ All local pre-push gates passed. Safe to push.")
}
