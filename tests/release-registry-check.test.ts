import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Behavioural regression coverage for the "Check Registry Availability" step
 * in .github/workflows/publish.yml.
 *
 * Regression for failed publish run 30671638543 (v1.0.2).
 *
 * Root cause: the step ran `LOOKUP_OUTPUT="$(npm view ...)"` under GitHub
 * Actions' default `bash -e` (errexit). When npm returns E404 for an
 * unpublished version — the EXPECTED state for a first publish — the command
 * substitution exits non-zero and bash terminates the step immediately,
 * before `LOOKUP_EXIT=$?` can be captured. The healthy "not yet published"
 * state therefore failed the workflow.
 *
 * These tests execute the EXACT step body extracted from publish.yml under
 * `bash -e` with a mocked `npm` binary, proving:
 *   - bash -e no longer aborts during the E404 lookup (errexit regression)
 *   - E404 "version not found" continues correctly (publish proceeds)
 *   - a published version fails immediately (duplicate publish blocked)
 *   - authentication, network, DNS, timeout, and unexpected npm failures all fail
 */

const publishYmlPath = join(process.cwd(), ".github", "workflows", "publish.yml")

/**
 * Extract the `run:` block body of the "Check Registry Availability" step
 * from publish.yml. Returns the raw shell lines (unindented).
 */
function extractRegistryCheckBody(content: string): string[] {
  const lines = content.split("\n")
  const stepIndex = lines.findIndex((l) => l.includes("- name: Check Registry Availability"))
  if (stepIndex === -1) throw new Error("Check Registry Availability step not found")

  // The next non-empty line must be `run: |`
  const runIndex = lines.findIndex((l, i) => i > stepIndex && l.trim() === "run: |")
  if (runIndex === -1) throw new Error("run: | block not found for step")

  const runIndent = lines[runIndex].match(/^\s*/)![0].length
  const body: string[] = []
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") {
      body.push("")
      continue
    }
    const indent = line.match(/^\s*/)![0].length
    if (indent <= runIndent) break // left the run block
    body.push(line.slice(runIndent))
  }
  return body
}

interface MockNpmSetup {
  root: string
  npmPath: string
}

/** Create a temp dir with package.json and a mock `npm` on PATH. */
function setupEnv(): MockNpmSetup {
  const root = join(tmpdir(), `fd-regcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(root, "bin"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@heidi-dang/flowdeck", version: "1.0.3", type: "module" }, null, 2),
  )

  const npmPath = join(root, "bin", "npm")
  writeFileSync(
    npmPath,
    [
      "#!/usr/bin/env bash",
      '# Mock npm for "Check Registry Availability" tests.',
      "# Simulates the outcome selected via MOCK_NPM_MODE.",
      "case \"$MOCK_NPM_MODE\" in",
      "  published)",
      '    echo "1.0.3"',
      "    exit 0",
      "    ;;",
      "  e404)",
      '    echo "npm error code E404" >&2',
      '    echo "npm error 404 No match found for version 1.0.3" >&2',
      '    echo "npm error 404" >&2',
      '    echo "npm error 404  The requested resource \'@heidi-dang/flowdeck@1.0.3\' could not be found" >&2',
      "    exit 1",
      "    ;;",
      "  auth)",
      '    echo "npm error code E401" >&2',
      '    echo "npm error 401 Unauthorized - GET https://registry.npmjs.org/@heidi-dang%2fflowdeck" >&2',
      "    exit 1",
      "    ;;",
      "  network)",
      '    echo "npm error code ENETUNREACH" >&2',
      '    echo "npm error network request to https://registry.npmjs.org failed" >&2',
      "    exit 1",
      "    ;;",
      "  dns)",
      '    echo "npm error code ENOTFOUND" >&2',
      '    echo "npm error network address not found" >&2',
      "    exit 1",
      "    ;;",
      "  timeout)",
      '    echo "npm error code ETIMEDOUT" >&2',
      '    echo "npm error request to https://registry.npmjs.org timed out" >&2',
      "    exit 1",
      "    ;;",
      "  unexpected)",
      '    echo "npm error code EJSONPARSE" >&2',
      '    echo "npm error Failed to parse JSON response" >&2',
      "    exit 1",
      "    ;;",
      "  *)",
      '    echo "mock npm: unknown mode $MOCK_NPM_MODE" >&2',
      "    exit 3",
      "    ;;",
      "esac",
    ].join("\n") + "\n",
    { mode: 0o644 },
  )
  chmodSync(npmPath, 0o755)
  return { root, npmPath }
}

/**
 * Run the extracted step body under `bash -e` (GitHub Actions default) with
 * the mock npm on PATH. Returns exit code and combined output.
 */
function runRegistryCheck(mode: string): { code: number; output: string } {
  const content = readFileSync(publishYmlPath, "utf-8")
  const body = extractRegistryCheckBody(content).join("\n")
  expect(body.length).toBeGreaterThan(0)
  // The body must still contain the errexit-safe lookup (sanity guard).
  expect(body).toContain("set +e")
  expect(body).toContain("npm view")

  const env = setupEnv()
  try {
    const result = spawnSync("bash", ["-e", "-c", body], {
      cwd: env.root,
      env: {
        ...(process.env as Record<string, string>),
        PATH: join(env.root, "bin") + ":" + (process.env.PATH ?? ""),
        HOME: join(env.root, "home"),
        MOCK_NPM_MODE: mode,
      },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    })
    return {
      code: result.status ?? 1,
      output: (result.stdout ?? "") + (result.stderr ?? ""),
    }
  } catch (e: any) {
    return { code: 2, output: e.message }
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
}

describe("Check Registry Availability (errexit-safe)", () => {
  it("unpublished version (E404) continues — publish is allowed", () => {
    const { code, output } = runRegistryCheck("e404")
    // The E404 text is captured internally (LOOKUP_OUTPUT) and not echoed on
    // the success path; the observable contract is: step continues, exit 0.
    expect(output).toContain("Registry availability verified")
    expect(code).toBe(0)
  })

  it("published version fails immediately — duplicate publish blocked", () => {
    const { code, output } = runRegistryCheck("published")
    expect(output).toContain("already exists")
    expect(code).toBe(1)
  })

  it("authentication failure stops the workflow", () => {
    const { code, output } = runRegistryCheck("auth")
    expect(output).toContain("E401")
    expect(output).toContain("failed unexpectedly")
    expect(code).toBe(1)
  })

  it("registry/network failure stops the workflow", () => {
    const { code, output } = runRegistryCheck("network")
    expect(output).toContain("ENETUNREACH")
    expect(output).toContain("failed unexpectedly")
    expect(code).toBe(1)
  })

  it("DNS failure stops the workflow", () => {
    const { code, output } = runRegistryCheck("dns")
    expect(output).toContain("ENOTFOUND")
    expect(output).toContain("failed unexpectedly")
    expect(code).toBe(1)
  })

  it("timeout failure stops the workflow", () => {
    const { code, output } = runRegistryCheck("timeout")
    expect(output).toContain("ETIMEDOUT")
    expect(output).toContain("failed unexpectedly")
    expect(code).toBe(1)
  })

  it("unexpected npm error stops the workflow", () => {
    const { code, output } = runRegistryCheck("unexpected")
    expect(output).toContain("EJSONPARSE")
    expect(output).toContain("failed unexpectedly")
    expect(code).toBe(1)
  })

  it("errexit regression: bash -e does not abort on the expected E404", () => {
    // The step body runs under `bash -e`. Before the fix, the E404 command
    // substitution aborted the step before LOOKUP_EXIT could be captured.
    // Reaching the "Registry availability verified" branch with exit 0 proves
    // errexit is scoped correctly around the lookup.
    const { code, output } = runRegistryCheck("e404")
    expect(code).toBe(0)
    expect(output).toContain("Registry availability verified")
  })

  it("command substitution regression: exit code is captured, not lost", () => {
    // Guard: the step must still assign LOOKUP_EXIT right after the lookup
    // inside the set +e / set -e scope, and must not use `|| true`.
    const content = readFileSync(publishYmlPath, "utf-8")
    const body = extractRegistryCheckBody(content).join("\n")
    expect(body).toMatch(/LOOKUP_EXIT=\$\?/)
    expect(body).not.toMatch(/\|\|\s*true/)
    // LOOKUP_EXIT capture must sit between set +e and set -e.
    const setPlus = body.indexOf("set +e")
    const setMinus = body.indexOf("set -e")
    const capture = body.indexOf("LOOKUP_EXIT=$?")
    expect(setPlus).toBeGreaterThan(-1)
    expect(setMinus).toBeGreaterThan(setPlus)
    expect(capture).toBeGreaterThan(setPlus)
    expect(capture).toBeLessThan(setMinus)
  })
})
