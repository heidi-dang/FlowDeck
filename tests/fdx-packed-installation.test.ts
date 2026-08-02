import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

import { detectFdxTarget } from "../src/tools/fdx-shared"

describe("FDX Clean Packed Installation Tests", () => {
  let projectDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "fdx-packed-project-"))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  it("packed CLI modules execute correctly from installed main tarball", () => {
    const root = resolve(__dirname, "..")

    // Build & pack local main package
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" })
    const mainPackOut = execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf-8" })
    const mainPackJson = JSON.parse(mainPackOut)
    const mainTarball = join(root, mainPackJson[0].filename)

    // Build local platform package for current host target
    execFileSync("node", ["scripts/build-fdx-packages.mjs"], { cwd: root, stdio: "ignore" })
    const target = detectFdxTarget()
    const pkgFolderName = target?.packageName ? target.packageName.replace("@heidi-dang/", "") : "flowdeck-fdx-linux-x64-gnu"
    const pkgDir = join(root, "packages", pkgFolderName)
    const pkgPackOut = execFileSync("npm", ["pack", "--json"], { cwd: pkgDir, encoding: "utf-8" })
    const pkgPackJson = JSON.parse(pkgPackOut)
    const platformTarball = join(pkgDir, pkgPackJson[0].filename)

    // Initialize clean project
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "test-consumer", version: "1.0.0", type: "module" }), "utf-8")

    // Install packed tarballs
    execFileSync("npm", ["install", mainTarball, platformTarball], { cwd: projectDir, stdio: "ignore" })

    const binName = process.platform === "win32" ? "flowdeck.cmd" : "flowdeck"
    const cliBin = join(projectDir, "node_modules", ".bin", binName)

    // 1. flowdeck fdx status
    const statusOut = execFileSync(cliBin, ["fdx", "status"], { cwd: projectDir, encoding: "utf-8" })
    expect(statusOut).toContain("=== FlowDeck FDX Native Status ===")
    expect(statusOut).toContain("Native Available:   Yes")

    // 2. flowdeck fdx verify
    const verifyOut = execFileSync(cliBin, ["fdx", "verify"], { cwd: projectDir, encoding: "utf-8" })
    expect(verifyOut).toContain("✓ FDX native binary verified successfully")

    // 3. flowdeck fdx install
    const installOut = execFileSync(cliBin, ["fdx", "install"], { cwd: projectDir, encoding: "utf-8" })
    expect(installOut).toContain("Compatible native FDX binary already available")

    // 4. flowdeck fdx repair
    const repairOut = execFileSync(cliBin, ["fdx", "repair"], { cwd: projectDir, encoding: "utf-8" })
    expect(repairOut).toContain("✓ FDX native installation successful")

    // 5. flowdeck doctor profiles
    const docMinimal = execFileSync(cliBin, ["doctor"], { cwd: projectDir, env: { ...process.env, FLOWDECK_PROFILE: "minimal" }, encoding: "utf-8" })
    expect(docMinimal).toBeDefined()

    const docRec = execFileSync(cliBin, ["doctor"], { cwd: projectDir, env: { ...process.env, FLOWDECK_PROFILE: "recommended-dev" }, encoding: "utf-8" })
    expect(docRec).toBeDefined()

    // Cleanup generated tarballs
    try { rmSync(mainTarball, { force: true }) } catch {}
    try { rmSync(platformTarball, { force: true }) } catch {}
  }, 120000)

  it("packed tarball includes crates/fdx source and excludes target build artifacts", () => {
    const root = resolve(__dirname, "..")
    const packOut = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf-8" })
    const files: string[] = JSON.parse(packOut)[0]?.files?.map((f: any) => f.path) ?? []

    const hasCargoToml = files.some(f => f === "crates/fdx/Cargo.toml")
    const hasTargetArtifacts = files.some(f => f.startsWith("crates/fdx/target"))

    expect(hasCargoToml).toBe(true)
    expect(hasTargetArtifacts).toBe(false)
  })
})
