/**
 * Pre-push validation gate.
 *
 * Fast mode (default / --fast):
 *   Reads changed files from pre-push stdin refs and runs only the checks
 *   relevant to those files, concurrently (max 3 parallel processes).
 *   Automatically escalates to full mode when foundational files change.
 *
 * Full mode (--full):
 *   Runs the complete sequential production verification suite including
 *   coverage enforcement, packaging, build, and optional Rust gates.
 *
 * Usage:
 *   node scripts/pre-push.mjs          # fast (default)
 *   node scripts/pre-push.mjs --fast   # fast explicit
 *   node scripts/pre-push.mjs --full   # full suite
 *
 * Package scripts:
 *   npm run verify:fast   →  node scripts/pre-push.mjs --fast
 *   npm run verify:full   →  node scripts/pre-push.mjs --full
 *
 * Git hook installation:
 *   .git/hooks/pre-push:
 *     #!/bin/sh
 *     exec node scripts/pre-push.mjs --fast "$@"
 *   (chmod +x .git/hooks/pre-push on Unix/macOS)
 */

import { execSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
export const root = join(__dirname, "..")

function defaultExec(cmd, cwd = root) {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
}

/**
 * Resolve the native Oxlint executable path.
 * Runs via process.execPath since it is a Node.js script.
 */
export function resolveOxlintExecutable() {
  const oxlintPkg = require.resolve("oxlint/package.json")
  return join(dirname(oxlintPkg), "bin", "oxlint")
}

/**
 * Resolve the Bun executable path.
 * On Unix, "bun" is a native binary. On Windows, find bun.exe
 * inside the npm global installation directory.
 */
export function getBunExecutable() {
  if (process.platform !== "win32") return "bun"
  const candidates = [
    join(process.env.APPDATA || "", "npm", "node_modules", "bun", "bin", "bun.exe"),
    join(process.env.LOCALAPPDATA || "", "bun", "bin", "bun.exe"),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // continue
    }
  }
  return "bun.exe"
}

/**
 * Resolve the TypeScript compiler tsc path.
 */
export function resolveTscPath() {
  return require.resolve("typescript/bin/tsc")
}

// ── Stdin / ref parsing ───────────────────────────────────────────────────────

/**
 * Parse standard Git pre-push hook stdin lines.
 * Format per line: <local-ref> <local-sha> <remote-ref> <remote-sha>
 */
export function parsePrePushStdin(stdinText) {
  if (stdinText === undefined || stdinText === null || typeof stdinText !== "string") {
    return []
  }
  const trimmedInput = stdinText.trim()
  if (trimmedInput.length === 0) return []

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
 * Read pre-push input from stdin unless stdin is a TTY.
 * In a Git hook, stdin is a pipe carrying pushed refs. In manual mode,
 * TTY stdin means there is no pipe, so we avoid blocking on readFileSync(fd=0).
 *
 * @param {{ isTTY?: boolean, readFn?: (fd: number) => string }} [opts]
 * @returns {string}
 */
export function readPrePushInput({ isTTY = process.stdin.isTTY, readFn = (fd) => readFileSync(fd, "utf-8") } = {}) {
  if (isTTY) return ""
  try {
    return readFn(0)
  } catch {
    return ""
  }
}

// ── Rust change detection ─────────────────────────────────────────────────────

/**
 * Detect Rust file changes under crates/fdx/ from pre-push stdin ref entries.
 * execFn is injected for testing; defaults to real execSync.
 */
export function detectRustChangesFromRefs(refEntries, cwd = root, execFn = defaultExec) {
  if (!Array.isArray(refEntries) || refEntries.length === 0) return null

  for (const entry of refEntries) {
    const { localSha, remoteSha } = entry
    const isNewBranch = !remoteSha || /^0+$/.test(remoteSha)

    if (isNewBranch) {
      try {
        let baseSha = null
        try {
          const upstream = execFn("git rev-parse --abbrev-ref @{upstream}", cwd).trim()
          if (upstream) {
            baseSha = execFn(`git merge-base "${upstream}" "${localSha}"`, cwd).trim()
          }
        } catch {
          // Upstream merge-base failed
        }
        if (!baseSha) {
          try {
            baseSha = execFn(`git merge-base "origin/main" "${localSha}"`, cwd).trim()
          } catch {
            // origin/main merge-base failed
          }
        }
        if (baseSha) {
          const diffOutput = execFn(`git diff --name-only "${baseSha}" "${localSha}"`, cwd)
          if (diffOutput.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))) {
            return true
          }
        } else {
          return true // Cannot establish merge base for new branch → conservative true
        }
      } catch {
        return true // Fail-closed on git command error
      }
    } else {
      try {
        const diffOutput = execFn(`git diff --name-only "${remoteSha}" "${localSha}"`, cwd)
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
 *   - Reliable comparison proves no Rust changes → false
 *   - Any Rust change detected → true
 *   - Comparison unavailable or ambiguous → true
 *   - Git command failure → true
 *   - Not inside a Git repository → true
 *
 * execFn is injected for testing; defaults to real execSync.
 */
export function detectRustChanges(stdinText = "", cwd = root, execFn = defaultExec) {
  try {
    // 1. Try parsing stdin ref data if passed by git pre-push hook
    if (stdinText && typeof stdinText === "string" && stdinText.trim().length > 0) {
      try {
        const refEntries = parsePrePushStdin(stdinText)
        const refResult = detectRustChangesFromRefs(refEntries, cwd, execFn)
        if (refResult !== null) return refResult
      } catch {
        return true // Malformed stdin ref data → conservative true
      }
    }

    // 2. Working tree status check (staged or unstaged Rust files)
    const status = execFn("git status --porcelain", cwd)
    const hasWorkingTreeRustChange = status.split("\n").some((line) => {
      const file = line.slice(3).trim()
      return file.startsWith("crates/fdx/")
    })
    if (hasWorkingTreeRustChange) return true

    // 3. Upstream branch merge-base check (@{upstream})
    try {
      const upstream = execFn("git rev-parse --abbrev-ref @{upstream}", cwd).trim()
      if (upstream) {
        const mergeBase = execFn(`git merge-base "${upstream}" HEAD`, cwd).trim()
        const diffUpstream = execFn(`git diff --name-only "${mergeBase}" HEAD`, cwd)
        return diffUpstream.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
      }
    } catch {
      // Upstream branch unconfigured or unreachable → fall through to origin/HEAD
    }

    // 4. Fallback to origin/HEAD merge-base check
    try {
      const mergeBaseOrigin = execFn('git merge-base "origin/HEAD" HEAD', cwd).trim()
      const diffOrigin = execFn(`git diff --name-only "${mergeBaseOrigin}" HEAD`, cwd)
      return diffOrigin.split("\n").some((file) => file.trim().startsWith("crates/fdx/"))
    } catch {
      // origin/HEAD unavailable
    }

    // 5. Comparison unavailable or ambiguous → fail-closed
    return true
  } catch {
    return true // git command failure or not in git repo → fail-closed
  }
}

// ── Changed-file collection ───────────────────────────────────────────────────

/**
 * Result of a changed-file-resolution attempt.
 *
 * @property files – the list of changed file paths.
 * @property source – "refs" when derived from pushed refs, "working-tree" for fallback.
 * @property trustworthy – true when the result is a reliable description of what
 *   will be pushed. Malformed or unverifiable hook input is untrustworthy.
 */
export class ChangedFilesResult {
  constructor(files, source, trustworthy) {
    this.files = files
    this.source = source
    this.trustworthy = trustworthy
  }
}

/**
 * Resolve the set of changed files from pre-push hook stdin or working tree.
 *
 * Behaviour per input:
 *   - No stdin / TTY / empty → working-tree fallback, trustworthy=true.
 *   - Valid ref entries        → git diff per ref, trustworthy=true.
 *   - Malformed non-empty      → throws so the caller fails closed.
 *   - Git comparison error     → trustworthy=false.
 *
 * @returns {ChangedFilesResult}
 */
export function getChangedFiles(stdinText = "", cwd = root, execFn = defaultExec) {
  const files = new Set()

  // Non-empty stdin → must be well-formed ref entries
  if (stdinText && typeof stdinText === "string" && stdinText.trim().length > 0) {
    let refEntries
    try {
      refEntries = parsePrePushStdin(stdinText)
    } catch (err) {
      // Malformed non-empty stdin → fail closed, do NOT fall back
      throw new Error(
        `Malformed pre-push hook input. stdin is non-empty but not valid ref data: ${err.message}`
      )
    }

    let gitError = false
    for (const { localSha, remoteSha } of refEntries) {
      const isNew = !remoteSha || /^0+$/.test(remoteSha)
      try {
        if (isNew) {
          let baseSha = null
          try {
            const upstream = execFn("git rev-parse --abbrev-ref @{upstream}", cwd).trim()
            if (upstream) baseSha = execFn(`git merge-base "${upstream}" "${localSha}"`, cwd).trim()
          } catch {
            // try origin/main next
          }
          if (!baseSha) {
            try {
              baseSha = execFn(`git merge-base "origin/main" "${localSha}"`, cwd).trim()
            } catch {
              // no base resolved
            }
          }
          if (baseSha) {
            const diff = execFn(`git diff --name-only "${baseSha}" "${localSha}"`, cwd)
            diff.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f))
          }
        } else {
          const diff = execFn(`git diff --name-only "${remoteSha}" "${localSha}"`, cwd)
          diff.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f))
        }
      } catch {
        gitError = true
      }
    }

    return new ChangedFilesResult([...files], "refs", !gitError && files.size > 0)
  }

  // No stdin → working-tree fallback (manual invocation)
  try {
    const status = execFn("git status --porcelain", cwd)
    status.split("\n").forEach((line) => {
      const f = line.slice(3).trim()
      if (f) files.add(f)
    })
  } catch {
    // ignore; return empty
  }

  return new ChangedFilesResult([...files], "working-tree", true)
}

// ── Escalation check (pure) ───────────────────────────────────────────────────

/**
 * Foundational files that require full-mode verification when changed.
 * Any match means focused fast checks are insufficient.
 */
const ESCALATION_PATTERNS = [
  /^package(?:-lock)?\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^tsconfig.*\.json$/,
  /^vitest\.config\./,
  /^tests\/lib\//,
  /^tests\/integration\//,
  /^\.github\/workflows\//,
]

/**
 * Returns true when any changed file could affect the entire build or test suite.
 * Pure function — no exec calls.
 */
export function isEscalationRequired(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false
  return changedFiles.some((file) => ESCALATION_PATTERNS.some((pat) => pat.test(file)))
}

// ── Fast check routing (pure) ─────────────────────────────────────────────────

/**
 * Maps src/ directories and specific script files to focused test paths.
 * Evaluated left-to-right; a file may match multiple rules.
 */
const SRC_TEST_MAP = [
  { match: (f) => f.startsWith("src/tools/"), testPath: "tests/tools/" },
  { match: (f) => f.startsWith("src/hooks/"), testPath: "tests/hooks/" },
  { match: (f) => f.startsWith("src/services/"), testPath: "tests/services/" },
  { match: (f) => f.startsWith("src/config/"), testPath: "tests/config/" },
  { match: (f) => f === "src/index.ts", testPath: "tests/index.test.ts" },
  { match: (f) => f === "scripts/check-coverage.mjs", testPath: "tests/check-coverage.test.ts" },
  { match: (f) => f === "scripts/pre-push.mjs", testPath: "tests/pre-push.test.ts" },
]

/**
 * Given a list of changed files, return focused test paths and fast tasks.
 * Pure function — no exec calls.
 *
 * @returns {{ testPaths: string[], fastTasks: { name: string, executable: string, args: string[] }[] }}
 */
export function routeFastChecks(changedFiles) {
  if (!Array.isArray(changedFiles)) return { testPaths: [], fastTasks: [] }

  const testPaths = new Set()
  const fastTasks = []
  let needsSkillValidation = false
  let needsDocValidation = false
  let needsRustCheck = false

  for (const file of changedFiles) {
    for (const { match, testPath } of SRC_TEST_MAP) {
      if (match(file)) testPaths.add(testPath)
    }
    if (file.startsWith("src/skills/")) needsSkillValidation = true
    if (file.startsWith("docs/")) needsDocValidation = true
    if (file.startsWith("crates/fdx/")) needsRustCheck = true
  }

  if (needsSkillValidation) {
    fastTasks.push({ name: "Skill Validation", executable: process.execPath, args: ["scripts/validate-skills.mjs"] })
  }
  if (needsDocValidation) {
    fastTasks.push({ name: "Documentation Validation", executable: process.execPath, args: ["scripts/validate-docs.mjs"] })
  }
  if (needsRustCheck) {
    const manifest = "crates/fdx/Cargo.toml"
    fastTasks.push({ name: "Rust Formatting", executable: "cargo", args: ["fmt", "--manifest-path", manifest, "--check"] })
    fastTasks.push({ name: "Rust Check", executable: "cargo", args: ["check", "--manifest-path", manifest] })
  }

  return { testPaths: [...testPaths], fastTasks }
}

// ── Full-mode step list (sequential) ─────────────────────────────────────────

/**
 * Return the complete ordered list of steps for full-mode verification.
 * If rustChanged is true and hasCargo is false, throws (fail-closed).
 */
export function getFullModeSteps(rustChanged, hasCargo) {
  const steps = [
    { name: "Lint", cmd: "npm run lint" },
    { name: "Typecheck", cmd: "npm run typecheck" },
    { name: "Test", cmd: "npm test" },
    { name: "Coverage", cmd: "node scripts/check-coverage.mjs" },
    { name: "Skill Validation", cmd: "npm run validate:skills" },
    { name: "Doc Validation", cmd: "npm run validate:docs" },
    { name: "Git Diff Check", cmd: "git diff --check" },
    { name: "Package Dry Run", cmd: "npm pack --dry-run" },
    { name: "Build", cmd: "npm run build" },
  ]

  if (rustChanged) {
    if (!hasCargo) {
      throw new Error(
        "Rust files under crates/fdx/ have changed (or comparison could not be verified), " +
          "but Cargo is not installed on PATH. Push blocked."
      )
    }
    const manifest = "crates/fdx/Cargo.toml"
    steps.push(
      { name: "Rust Formatting", cmd: `cargo fmt --manifest-path ${manifest} --check` },
      { name: "Rust Clippy", cmd: `cargo clippy --manifest-path ${manifest} --all-targets -- -D warnings` },
      { name: "Rust Tests", cmd: `cargo test --manifest-path ${manifest} --all` },
      { name: "Rust Build", cmd: `cargo build --manifest-path ${manifest}` }
    )
  }

  return steps
}

// ── Push-range resolution ──────────────────────────────────────────────────────

/**
 * Resolve diff ranges for validation from pre-push stdin ref entries.
 * Returns an array of { baseSha, localSha } pairs for each pushed ref.
 * Throws on malformed stdin. Returns empty for TTY / empty input.
 */
export function resolvePushRanges(stdinText = "", cwd = root, execFn = defaultExec) {
  if (!stdinText || typeof stdinText !== "string" || stdinText.trim().length === 0) {
    return []
  }

  const refEntries = parsePrePushStdin(stdinText)
  const ranges = []

  for (const entry of refEntries) {
    const { localSha, remoteSha } = entry
    const isNew = !remoteSha || /^0+$/.test(remoteSha)

    if (isNew) {
      let baseSha = null
      try {
        const upstream = execFn("git rev-parse --abbrev-ref @{upstream}", cwd).trim()
        if (upstream) baseSha = execFn(`git merge-base "${upstream}" "${localSha}"`, cwd).trim()
      } catch { /* try origin/main */ }

      if (!baseSha) {
        try {
          baseSha = execFn(`git merge-base "origin/main" "${localSha}"`, cwd).trim()
        } catch { /* no base */ }
      }

      if (baseSha) {
        ranges.push({ baseSha, localSha })
      }
      // If no base can be resolved, the range is omitted — caller must handle
    } else {
      ranges.push({ baseSha: remoteSha, localSha })
    }
  }

  return ranges
}

/**
 * Build git diff --check tasks for every resolved push range.
 * Each task uses argv-safe { executable, args }.
 * Returns empty array when no ranges are available (manual execution).
 */
export function getDiffCheckTasks(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    // No ranges available → fall back to working-tree check
    return [{ name: "Git Diff Check", executable: "git", args: ["diff", "--check"] }]
  }

  return ranges.map((r, i) => ({
    name: `Git Diff Check (ref ${i + 1})`,
    executable: "git",
    args: ["diff", "--check", r.baseSha, r.localSha],
  }))
}

// ── Parallel runner ───────────────────────────────────────────────────────────

/** Run a process, streaming output, resolve with name and exit code. */
function runProcess(name, executable, args) {
  return new Promise((resolve) => {
    const proc = spawn(executable, args, { shell: false, cwd: root, stdio: "inherit" })
    proc.on("close", (code) => resolve({ name, cmd: `${executable} ${args.join(" ")}`, code: code ?? 1 }))
    proc.on("error", () => resolve({ name, cmd: `${executable} ${args.join(" ")}`, code: 1 }))
  })
}

/** Run tasks (Promise factories) concurrently with a max-concurrency limit. */
async function runConcurrent(tasks, limit = 3) {
  const results = []
  const queue = [...tasks]
  const active = new Set()

  await new Promise((resolve) => {
    function next() {
      while (active.size < limit && queue.length > 0) {
        const task = queue.shift()
        const p = task().then((r) => {
          results.push(r)
          active.delete(p)
          if (queue.length === 0 && active.size === 0) resolve()
          else next()
        })
        active.add(p)
      }
      if (active.size === 0 && queue.length === 0) resolve()
    }
    next()
  })

  return results
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = process.argv.slice(2)
  const fullMode = args.includes("--full")

  const stdinContent = readPrePushInput()

  /** Run the complete sequential full-mode suite. */
  async function runFullMode() {
    console.log("\n── Full mode: complete production verification ──")
    const rustChanged = detectRustChanges(stdinContent, root)

    let hasCargo = false
    try {
      execSync("cargo --version", { stdio: "ignore" })
      hasCargo = true
    } catch {
      // No cargo
    }

    let steps = []
    try {
      steps = getFullModeSteps(rustChanged, hasCargo)
    } catch (err) {
      console.error(`\n✗ ${err.message}`)
      process.exit(1)
    }

    if (!rustChanged) console.log("(No crates/fdx/ changes; Rust gates skipped)")

    for (const { name, cmd } of steps) {
      console.log(`\n── ${name} ──`)
      try {
        execSync(cmd, { cwd: root, stdio: "inherit" })
      } catch {
        console.error(`\n✗ ${name} failed. Push blocked.`)
        process.exit(1)
      }
    }

    console.log("\n✓ All full-mode verification steps passed. Safe to push.")
  }

  /** Run focused fast checks for changed files only, concurrently. */
  async function runFastMode() {
    let changedResult
    try {
      changedResult = getChangedFiles(stdinContent, root)
    } catch (err) {
      console.error(`\n✗ ${err.message}`)
      process.exit(1)
    }

    if (changedResult.files.length === 0) {
      if (changedResult.source === "refs" && !changedResult.trustworthy) {
        console.error("\n✗ Pre-push hook input is unverifiable. Push blocked.")
        process.exit(1)
      }
      console.log("\n✓ No changed files detected. Nothing to verify.")
      process.exit(0)
    }

    if (!changedResult.trustworthy) {
      console.error("\n✗ Changed-file comparison is unreliable. Escalating to full mode.")
      return runFullMode()
    }

    if (isEscalationRequired(changedResult.files)) {
      console.log("\n⚠ Foundational files changed — escalating to full mode.")
      return runFullMode()
    }

    const { testPaths, fastTasks } = routeFastChecks(changedResult.files)
    const lintTargets = changedResult.files.filter((f) => /\.(ts|js|mjs)$/.test(f))

    console.log(`\n── Fast mode: ${changedResult.files.length} changed file(s) ──`)
    if (testPaths.length > 0) console.log(`   Tests    : ${testPaths.join(", ")}`)
    if (fastTasks.length > 0) console.log(`   Extra    : ${fastTasks.map((t) => t.name).join(", ")}`)

    // Pushed-range git diff --check (argv-safe)
    const ranges = resolvePushRanges(stdinContent, root)
    const diffTasks = getDiffCheckTasks(ranges)
    for (const dt of diffTasks) {
      const result = await runProcess(dt.name, dt.executable, dt.args)
      if (result.code !== 0) {
        console.error(`\n✗ ${dt.name} failed (trailing whitespace / merge markers). Push blocked.`)
        process.exit(1)
      }
    }

    // Build concurrent task list
    const tasks = []
    const oxlintBin = resolveOxlintExecutable()
    const tscPath = resolveTscPath()
    const bunBin = getBunExecutable()

    if (lintTargets.length > 0) {
      tasks.push(() => runProcess("Lint", process.execPath, [oxlintBin, "--deny-warnings", ...lintTargets]))
    }

    tasks.push(() => runProcess("Typecheck", process.execPath, [tscPath, "--noEmit", "--project", "tsconfig.prepush.json"]))

    if (testPaths.length > 0) {
      tasks.push(() => runProcess("Test", bunBin, ["test", ...testPaths]))
    }

    for (const task of fastTasks) {
      tasks.push(() => runProcess(task.name, task.executable, task.args))
    }

    const results = await runConcurrent(tasks, 3)
    const failures = results.filter((r) => r.code !== 0)

    if (failures.length > 0) {
      console.error(
        `\n✗ ${failures.length} fast check(s) failed: ${failures.map((r) => r.name).join(", ")}. Push blocked.`
      )
      process.exit(1)
    }

    console.log("\n✓ All fast pre-push checks passed. Safe to push.")
  }

  if (fullMode) {
    runFullMode()
  } else {
    runFastMode()
  }
}
