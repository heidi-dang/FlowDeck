/**
 * Pre-push validation gate.
 *
 * Runs fast local pre-push checks before pushing to remote:
 *   1. Lint (npm run lint)
 *   2. Typecheck (npm run typecheck)
 *   3. Test (npm test)
 *   4. Skill Validation (npm run validate:skills)
 *   5. Doc Validation (npm run validate:docs)
 *   6. Git Diff Whitespace Check (git diff --check)
 *   7. Package Dry Run (npm pack --dry-run)
 *   8. Build (npm run build)
 *   9. Rust Gates (conditional when crates/fdx/ changes and cargo is installed)
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

// Conditionally append Rust checks if crates/fdx files changed and cargo is available
try {
  const changed = execSync("git diff --name-only HEAD origin/HEAD", { cwd: root, encoding: "utf-8" })
  if (changed.includes("crates/fdx")) {
    try {
      execSync("cargo --version", { stdio: "ignore" })
      steps.push({ name: "Rust Gates", cmd: "cargo test --manifest-path crates/fdx/Cargo.toml" })
    } catch {
      console.log("\n(Cargo not found on PATH; skipping optional Rust gates)")
    }
  }
} catch {
  // Ignored if origin/HEAD not available locally
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
