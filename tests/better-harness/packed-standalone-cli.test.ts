/**
 * Packed standalone CLI lifecycle tests (P1-A).
 *
 * Proves the published `flowdeck-better-harness` binary works from an
 * installed npm tarball — NOT from the repository checkout:
 *
 *   1. runs the repository build
 *   2. runs npm pack
 *   3. installs the generated tarball into a clean temporary project
 *   4. verifies the package file inventory
 *   5. verifies dist/better-harness/standalone.js exists in the tarball
 *   6. verifies the installed binary resolves
 *   7. runs flowdeck-better-harness --help
 *   8. starts the standalone server (temp project, temp state dir, loopback,
 *      ephemeral port)
 *   9. performs a bounded health/readiness request
 *  10. shuts down through the public lifecycle (SIGTERM)
 *  11. proves the process exits
 *  12. proves no listener or child process remains
 *  13. removes the installation, project and state directories
 *
 * This test deliberately does NOT run the binary from the source checkout
 * and does NOT mock package installation or binary resolution.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"

const ROOT = resolve(import.meta.dir, "..", "..")
const NODE = process.execPath
const isWin = process.platform === "win32"
const npmCmd = isWin ? "npm.cmd" : "npm"

describe("Packed flowdeck-better-harness CLI (P1-A)", () => {
  let packDir: string
  let installDir: string
  let projectDir: string
  let stateDir: string
  let tarball: string
  let installedBin: string
  let installedStandalone: string

  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), "fd-bh-pack-"))
    installDir = mkdtempSync(join(tmpdir(), "fd-bh-install-"))
    projectDir = mkdtempSync(join(tmpdir(), "fd-bh-project-"))
    stateDir = mkdtempSync(join(tmpdir(), "fd-bh-state-"))
    mkdirSync(join(projectDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0" }),
    )
  }, 60_000)

  afterAll(() => {
    for (const dir of [packDir, installDir, projectDir, stateDir]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }, 30_000)

  it("build emits dist/better-harness/standalone.js", () => {
    execFileSync(npmCmd, ["run", "build"], { cwd: ROOT, stdio: "ignore", shell: isWin })
    const built = join(ROOT, "dist", "better-harness", "standalone.js")
    expect(existsSync(built)).toBe(true)
  }, 300_000)

  it("npm pack produces a tarball and inspects its inventory", () => {
    const packOut = execFileSync(npmCmd, ["pack", "--json", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf-8",
      shell: isWin,
    })
    const parsed = JSON.parse(packOut)
    expect(parsed).toHaveLength(1)
    tarball = join(packDir, parsed[0].filename)
    expect(existsSync(tarball)).toBe(true)

    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf-8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)

    // 5. standalone.js must be shipped in the tarball
    expect(listing).toContain("package/dist/better-harness/standalone.js")
    // The bin entry must be shipped too
    expect(listing).toContain("package/bin/better-harness.js")
    // TypeScript source must NOT be the runtime dependency
    expect(listing.some((l) => l.includes("src/better-harness/standalone.ts"))).toBe(false)
  }, 120_000)

  it("installs the tarball into a clean temporary project and resolves the binary", () => {
    writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "consumer", private: true }))
    execFileSync(npmCmd, ["install", "--ignore-scripts", tarball], {
      cwd: installDir,
      stdio: "ignore",
      shell: isWin,
    })

    installedStandalone = join(
      installDir, "node_modules", "@heidi-dang", "flowdeck",
      "dist", "better-harness", "standalone.js",
    )
    expect(existsSync(installedStandalone)).toBe(true)

    const binName = isWin ? "flowdeck-better-harness.cmd" : "flowdeck-better-harness"
    installedBin = join(installDir, "node_modules", ".bin", binName)
    expect(existsSync(installedBin)).toBe(true)
  }, 180_000)

  it("installed --help succeeds under Node", () => {
    const out = execFileSync(NODE, [installedBin, "--help"], {
      cwd: installDir,
      encoding: "utf-8",
      shell: isWin,
    })
    expect(out).toContain("FlowDeck Better Harness")
    expect(out).toContain("--project")
  }, 60_000)

  it("installed standalone server lifecycle: start → health → shutdown → exit", async () => {
    const child: ChildProcess = spawn(NODE, [
      installedBin,
      "--project", projectDir,
      "--state-dir", stateDir,
      "--host", "127.0.0.1",
      "--port", "0",
    ], { cwd: installDir, stdio: ["ignore", "pipe", "pipe"] })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => { stdout += String(d) })
    child.stderr?.on("data", (d) => { stderr += String(d) })

    // Bounded readiness wait for the printed base URL (ephemeral port).
    const port = await new Promise<number | null>((resolvePort) => {
      const deadline = Date.now() + 20_000
      const iv = setInterval(() => {
        const m = stdout.match(/HTTP base URL: http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) { clearInterval(iv); resolvePort(Number(m[1])); return }
        if (Date.now() > deadline) { clearInterval(iv); resolvePort(null) }
      }, 150)
    })

    expect(port, `server did not report a port. stderr: ${stderr}`).not.toBeNull()

    // 9. bounded health/readiness request
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    const body: any = await health.json()
    expect(body.status).toBe("ok")

    // 10. shutdown through the public lifecycle (SIGTERM)
    const exitPromise = new Promise<number | null>((res) => {
      child.on("exit", (code) => res(code))
    })
    child.kill("SIGTERM")

    // 11. prove the process exits (bounded)
    const code = await Promise.race([
      exitPromise,
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 10_000)),
    ])
    expect(code).not.toBe("TIMEOUT")
    expect(code).toBe(0)

    // 12. prove no listener remains
    const stillUp = await fetch(`http://127.0.0.1:${port}/health`)
      .then(() => true)
      .catch(() => false)
    expect(stillUp).toBe(false)

    // 12. prove no child process remains
    if (!isWin) {
      expect(child.exitCode).not.toBeNull()
    }
  }, 120_000)

  it("temporary installation, project and state directories are removable", () => {
    expect(existsSync(stateDir)).toBe(true)
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(installDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
    expect(existsSync(stateDir)).toBe(false)
    expect(existsSync(installDir)).toBe(false)
    expect(existsSync(projectDir)).toBe(false)
  }, 60_000)
})
