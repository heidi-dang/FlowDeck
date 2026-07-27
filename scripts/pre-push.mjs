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
 *   9. Rust Gates (conditional when crates/fdx/ changes; fails closed if Cargo missing)
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
import { readFileSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const root = join(__dirname, "..")

/**
 * Parse standard Git pre-push hook stdin lines.
 * Format per line: <local-ref> <local-sha> <remote-ref> <remote-sha>
 */
export function parsePrePushStdin(stdinText) {
  if (stdinText === undefined || stdinText === null || typeof stdinText !== "string") {
    return []
  }

  const trimmedInput = stdinText.trim()
  if (trimmedInput.length === 0) {
    return []
  }

  const lines = trimmedInput.split("\n")
  const refEntries = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 4) {
      throw new Error(`Malformed pre-push stdin ref line: "${line}"`)
    }
    const [localRef, localSha, remoteRef, remoteSha] = parts
    refEntries.push({ localRef, localSha, remoteRef, remoteSha })
  }

  return refEntries
}

/**
 * Detect Rust file changes under crates/fdx/ from pre-push stdin ref entries.
 */
export function detectRustChangesFromRefs(refEntries, cwd = root) {
  if (!Array.isArray(refEntries) || refEntries.length === 0) {
    return null
  }

  for (const entry of refEntries) {
    const { localSha, remoteSha } = entry
    const isNewBranch = !remoteSha || /^0+$/.test(remoteSha)

    if (isNewBranch) {
      try {
        let baseSha = null
        try {
          const upstream = execSync("git rev-parse --abbrev-ref @{upstream}", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
          if (upstream) {
            baseSha = execSync(`git merge-base "${upstream}" "${localSha}"`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
          }
        } catch {
          // Upstream merge base failed
        }

        if (!baseSha) {
          try {
            baseSha = execSync(`git merge-base "origin/main" "${localSha}"`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
          } catch {
            // origin/main merge base failed
          }
        }

        if (baseSha) {
          const diffOutput = execSync(`git diff --name-only "${baseSha}" "${localSha}"`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
          if (diffOutput.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))) {
            return true
          }
        } else {
          return true // Cannot establish merge base for new branch -> conservative return true
        }
      } catch {
        return true // Fail-closed on git command error
      }
    } else {
      try {
        const diffOutput = execSync(`git diff --name-only "${remoteSha}" "${localSha}"`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        if (diffOutput.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))) {
          return true
        }
      } catch {
        return true // Fail-closed on git diff error
      }
    }
  }

  return false
}

/**
 * Fail-closed detection of Rust file changes under crates/fdx/.
 *
 * Rules:
 *   - Reliable comparison proves no Rust changes -> false
 *   - Any Rust change detected -> true
 *   - Comparison unavailable or ambiguous -> true
 *   - Git command failure -> true
 *   - Not inside a Git repository -> true
 */
export function detectRustChanges(stdinText = "", cwd = root) {
  try {
    // 1. Try parsing stdin ref data if passed by git pre-push hook
    if (stdinText && typeof stdinText === "string" && stdinText.trim().length > 0) {
      try {
        const refEntries = parsePrePushStdin(stdinText)
        const refResult = detectRustChangesFromRefs(refEntries, cwd)
        if (refResult !== null) {
          return refResult
        }
      } catch {
        // Malformed stdin ref data -> conservative return true
        return true
      }
    }

    // 2. Working tree status check (staged or unstaged)
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    const hasWorkingTreeRustChange = status.split("\n").some((line) => {
      const file = line.slice(3).trim()
      return file.startsWith("crates/fdx/")
    })
    if (hasWorkingTreeRustChange) return true

    // 3. Upstream branch merge-base check (@{upstream})
    try {
      const upstream = execSync("git rev-parse --abbrev-ref @{upstream}", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      if (upstream) {
        const mergeBase = execSync(`git merge-base "${upstream}" HEAD`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
        const diffUpstream = execSync(`git diff --name-only "${mergeBase}" HEAD`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        const hasDiff = diffUpstream.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
        return hasDiff // Reliable upstream check: returns true if diff found, false if clean
      }
    } catch {
      // Upstream branch unconfigured or unreachable -> fall through to origin/HEAD
    }

    // 4. Fallback to origin/HEAD merge-base check
    try {
      const mergeBaseOrigin = execSync('git merge-base "origin/HEAD" HEAD', { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      const diffOrigin = execSync(`git diff --name-only "${mergeBaseOrigin}" HEAD`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      const hasDiff = diffOrigin.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
      return hasDiff // Reliable origin/HEAD check: returns true if diff found, false if clean
    } catch {
      // origin/HEAD unavailable
    }

    // 5. Fail-closed fallback: comparison unavailable or ambiguous -> return true
    return true
  } catch {
    // Fail-closed fallback: git command failure or not in git repo -> return true
    return true
  }
}

/**
 * Return list of steps to execute for pre-push gate.
 * If rustChanged is true and hasCargo is false, throws error (fail-closed).
 */
export function getRequiredSteps(rustChanged, hasCargo) {
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

  if (rustChanged) {
    if (!hasCargo) {
      throw new Error("Rust files under crates/fdx/ have changed (or comparison could not be verified), but Cargo is not installed on PATH. Push blocked.")
    }

    const manifestPath = "crates/fdx/Cargo.toml"
    steps.push(
      { name: "Rust Formatting", cmd: `cargo fmt --manifest-path ${manifestPath} --check` },
      { name: "Rust Clippy", cmd: `cargo clippy --manifest-path ${manifestPath} --all-targets -- -D warnings` },
      { name: "Rust Tests", cmd: `cargo test --manifest-path ${manifestPath} --all` },
      { name: "Rust Build", cmd: `cargo build --manifest-path ${manifestPath}` }
    )
  }

  return steps
}

// Execute CLI entry point when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let stdinContent = ""
  try {
    stdinContent = readFileSync(0, "utf-8")
  } catch {
    // No stdin data provided (manual run)
  }

  const rustChanged = detectRustChanges(stdinContent, root)

  let hasCargo = false
  try {
    execSync("cargo --version", { stdio: "ignore" })
    hasCargo = true
  } catch {
    hasCargo = false
  }

  let steps = []
  try {
    steps = getRequiredSteps(rustChanged, hasCargo)
  } catch (err) {
    console.error(`\n✗ ${err.message}`)
    process.exit(1)
  }

  if (!rustChanged) {
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
}
