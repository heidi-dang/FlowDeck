/**
 * Pre-push validation gate.
 *
 * Runs the same checks as CI so failures are caught locally before push:
 *   1. Lint (oxlint --deny-warnings)
 *   2. Typecheck (tsc --noEmit)
 *   3. Test (bun test)
 *   4. Build (bun run build)
 *
 * Usage:
 *   node scripts/pre-push.mjs
 *
 * To install as a git hook:
 *   ln -s ../../scripts/pre-push.mjs .git/hooks/pre-push
 *   # or on Windows:
 *   copy scripts\pre-push.mjs .git\hooks\pre-push
 */

import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const steps = [
  { name: "Lint", cmd: "bun run lint" },
  { name: "Typecheck", cmd: "bun run typecheck" },
  { name: "Test", cmd: "bun test" },
  { name: "Build", cmd: "bun run build" },
]

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
  console.log("\n✓ All gates passed. Safe to push.")
}
