import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { runFdxChecks } from "../src/doctor/checks/fdx"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const CURRENT_CAPABILITIES = {
  capability_contract_version: 1,
  fdx_protocol_version: 2,
  graph_schema: {
    minimum_readable: 1,
    maximum_writable: 10,
    can_read: true,
    can_write: true,
    can_verify: true,
  },
  selection_policy_version: 1,
  verification_predicate_versions: ["v1", "v2"],
  calibration_contract_versions: [2],
  policy_contract_versions: [1],
  assurance_levels: ["EXACT"],
  network_access: false,
  telemetry: false,
  platform: process.platform,
  platform_limitations: [],
}

describe("Doctor FDX Checks", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fdx-checks-test-"))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  function installNativeFixture(capabilities: unknown): string {
    const binary = join(tmpDir, process.platform === "win32" ? "fdx.exe" : "fdx")
    const serialized = JSON.stringify(capabilities)
    writeFileSync(binary, `#!/usr/bin/env node
const command = process.argv[2]
if (command === "--version") { console.log("fdx 0.1.0"); process.exit(0) }
if (command === "capabilities") { console.log(${JSON.stringify(serialized)}); process.exit(0) }
if (command === "search") { console.log("[]"); process.exit(0) }
if (command === "serve") {
  process.stdin.on("data", () => console.log(JSON.stringify({ healthy: true })))
  process.stdin.resume()
  return
}
process.exit(0)
`, { mode: 0o755 })
    chmodSync(binary, 0o755)
    return binary
  }

  function checkById(checks: Awaited<ReturnType<typeof runFdxChecks>>, id: string) {
    const check = checks.find(candidate => candidate.id === id)
    expect(check).toBeDefined()
    return check!
  }

  it("evaluates when fdx index cache exists", async () => {
    const flowdeckDir = join(tmpDir, ".flowdeck")
    mkdirSync(flowdeckDir, { recursive: true })
    writeFileSync(join(flowdeckDir, "fdx-index.json"), "{}")

    const checks = await runFdxChecks(tmpDir)
    const indexCheck = checkById(checks, "fdx.index_cache")
    expect(indexCheck.status).toBe("pass")
    expect(indexCheck.detected).toContain(".flowdeck/fdx-index.json present")
  })

  it("treats a missing native binary as an authority error in a repository-like environment", async () => {
    const missing = join(tmpDir, "missing-fdx")
    const checks = await runFdxChecks(tmpDir, { nativeBinaryPath: missing })
    const binaryCheck = checkById(checks, "fdx.native_binary")
    expect(binaryCheck.status).toBe("error")
    expect(binaryCheck.detected).toContain("cannot qualify VCI authority")
  })

  it("reports a current native FDX protocol and exact graph schema as healthy", async () => {
    const binary = installNativeFixture(CURRENT_CAPABILITIES)

    const checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.native_binary").status).toBe("pass")
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("pass")
    expect(checkById(checks, "fdx.vci_protocol_compat").status).toBe("pass")
    expect(checkById(checks, "fdx.vci_graph_schema").status).toBe("pass")
  })

  it("rejects stale protocol v1 rather than reporting a healthy capability contract", async () => {
    const binary = installNativeFixture({ ...CURRENT_CAPABILITIES, fdx_protocol_version: 1 })

    const checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("error")
    expect(checkById(checks, "fdx.vci_protocol_compat").status).toBe("error")
  })

  it("rejects newer unsupported protocol versions", async () => {
    const binary = installNativeFixture({ ...CURRENT_CAPABILITIES, fdx_protocol_version: 3 })

    const checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("error")
    expect(checkById(checks, "fdx.vci_protocol_compat").status).toBe("error")
  })

  it("fails closed for malformed capability JSON", async () => {
    const binary = installNativeFixture("not-a-capability-document")

    const checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("error")
    expect(checkById(checks, "fdx.vci_protocol_compat").status).toBe("error")
    expect(checkById(checks, "fdx.vci_graph_schema").status).toBe("error")
  })

  it("rejects stale and newer graph schemas rather than treating max-write as a range", async () => {
    let binary = installNativeFixture({
      ...CURRENT_CAPABILITIES,
      graph_schema: { ...CURRENT_CAPABILITIES.graph_schema, maximum_writable: 9 },
    })
    let checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("error")
    expect(checkById(checks, "fdx.vci_graph_schema").status).toBe("error")

    binary = installNativeFixture({
      ...CURRENT_CAPABILITIES,
      graph_schema: { ...CURRENT_CAPABILITIES.graph_schema, maximum_writable: 11 },
    })
    checks = await runFdxChecks(tmpDir, { nativeBinaryPath: binary })
    expect(checkById(checks, "fdx.vci_capability_contract").status).toBe("error")
    expect(checkById(checks, "fdx.vci_graph_schema").status).toBe("error")
  })
})
