/**
 * Streamed Installer Regression Tests
 *
 * Executes the real `install.sh` exactly as a user would via
 * `curl ... | bash -s -- <args>` — the script is piped through stdin.
 *
 * Regression for v1.0.0 defect: `DOCTOR_PROFILE` was referenced at
 * install.sh:236 with `set -euo pipefail` active but never initialised,
 * aborting EVERY plain streamed install with "unbound variable".
 *
 * These tests run the installer with stubbed `node`/`npm` binaries on PATH
 * so the full control flow executes without network access or side effects.
 */

import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ROOT = join(__dirname, "..", "..")
const INSTALL_SCRIPT = join(ROOT, "install.sh")

// ─── Stub toolchain ─────────────────────────────────────────────────────

function makeStubDir(): string {
  const dir = join(tmpdir(), `fd-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })

  // Stub node: answer the version probe; ignore everything else (exit 0).
  // The `node -e "console.log(process.version.slice(1))"` call is the only
  // node invocation a plain non-doctor install makes.
  writeFileSync(
    join(dir, "node"),
    "#!/usr/bin/env bash\nif [[ \"$*\" == *\"process.version\"* ]]; then echo \"22.0.0\"; fi\nexit 0\n",
    { mode: 0o755 },
  )

  // Stub npm: answer --version, `npm view`, and `npm exec` (simulated install).
  writeFileSync(
    join(dir, "npm"),
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    --version) echo "10.0.0"; exit 0 ;;
    view) echo "1.0.1"; exit 0 ;;
    exec) echo "[stub] npm exec invoked: $*"; exit 0 ;;
  esac
done
exit 0
`,
    { mode: 0o755 },
  )

  return dir
}

function streamInstall(workdir: string, extraEnv: Record<string, string> = {}): {
  code: number
  stdout: string
  stderr: string
} {
  const script = readFileSync(INSTALL_SCRIPT, "utf-8")
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...extraEnv,
    // Neutral HOME so the script never touches real user config
    HOME: join(workdir, "home"),
  }
  mkdirSync(env.HOME, { recursive: true })

  try {
    const result = spawnSync("bash", ["-s", "--", "--dry-run", "--non-interactive"], {
      input: script,
      cwd: workdir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
      env,
    })
    return {
      code: result.status ?? 1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    }
  } catch (e: any) {
    return { code: 2, stdout: "", stderr: e.message }
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("streamed installer (curl | bash)", () => {
  it("completes a plain streamed install without unbound-variable failure", () => {
    const workdir = join(tmpdir(), `fd-stream-work-${Date.now()}`)
    mkdirSync(workdir, { recursive: true })
    const stubBin = makeStubDir()

    const result = streamInstall(workdir, {
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    })

    // The v1.0.0 bug aborted with "DOCTOR_PROFILE: unbound variable" here.
    expect(result.stderr).not.toContain("unbound variable")
    expect(result.stdout).toContain("FlowDeck installation completed")
    expect(result.code).toBe(0)

    rmSync(workdir, { recursive: true, force: true })
    rmSync(stubBin, { recursive: true, force: true })
  })

  it("reaches the pre-install doctor gate without crashing", () => {
    const workdir = join(tmpdir(), `fd-stream-work2-${Date.now()}`)
    mkdirSync(workdir, { recursive: true })
    const stubBin = makeStubDir()

    const result = streamInstall(workdir, {
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    })

    // Line 236-249 is executed on every install; before the fix the
    // `-n "$DOCTOR_PROFILE"` guard aborted under `set -u`.
    expect(result.stderr).not.toContain("unbound variable")
    expect(result.code).toBe(0)

    rmSync(workdir, { recursive: true, force: true })
    rmSync(stubBin, { recursive: true, force: true })
  })

  it("initialises DOCTOR_PROFILE alongside the other doctor flags", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    // The initialiser must live in the same declaration block as the other
    // doctor flags, BEFORE the first `[ -n "$DOCTOR_PROFILE" ]` use.
    const declIndex = content.indexOf('NON_INTERACTIVE=false; PROFILE="recommended-dev"; DOCTOR_PROFILE=""')
    const useIndex = content.indexOf('-n "$DOCTOR_PROFILE"')
    expect(declIndex).toBeGreaterThan(-1)
    expect(useIndex).toBeGreaterThan(-1)
    expect(declIndex).toBeLessThan(useIndex)
  })
})
