import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import flowDeckPlugin from "../src/index"
import { isBlocked, SENSITIVE_READ_TOOLS } from "../src/hooks/tool-guard"
import { checkSensitivePath } from "../src/services/sensitive-path"

describe("Direct Sensitive Read Protection Lifecycle", () => {
  const testDir = join(tmpdir(), "sensitive-read-lifecycle-" + Date.now())
  let pluginInstance: any

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "package.json"), '{"name":"test"}\n')
    writeFileSync(join(testDir, "README.md"), "# Test\n")
    mkdirSync(join(testDir, "src"), { recursive: true })
    writeFileSync(join(testDir, "src", "index.ts"), "export const ok = true;\n")
    writeFileSync(join(testDir, ".env"), "SECRET_KEY=12345\n")

    pluginInstance = await (flowDeckPlugin as any).server({
      directory: testDir,
      client: { app: { log: async () => {} } } as any,
    })
  })

  afterEach(async () => {
    if (pluginInstance?.dispose) await pluginInstance.dispose()
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it("verifies SENSITIVE_READ_TOOLS contains read, read_file, and fdx-read", () => {
    expect(SENSITIVE_READ_TOOLS.has("read")).toBe(true)
    expect(SENSITIVE_READ_TOOLS.has("read_file")).toBe(true)
    expect(SENSITIVE_READ_TOOLS.has("fdx-read")).toBe(true)
  })

  it("blocks sensitive paths in isBlocked for all registered read tools and argument aliases", () => {
    const tools = ["read", "read_file", "fdx-read"]
    const sensitiveCases = [
      { file: ".env" },
      { filePath: ".env" },
      { file_path: ".env" },
      { path: ".env" },
      { file: ".ssh/id_rsa" },
      { filePath: "credentials.json" },
      { file_path: "/etc/passwd" },
      { path: ".aws/credentials" },
      { file: ".kube/config" },
      { file: "service-account.json" },
    ]

    for (const toolName of tools) {
      for (const args of sensitiveCases) {
        const reason = isBlocked(toolName, args, testDir)
        expect(reason).not.toBeNull()
        expect(reason).toContain("blocked")
      }
    }
  })

  it("allows benign paths in isBlocked for all registered read tools", () => {
    const tools = ["read", "read_file", "fdx-read"]
    const benignCases = [
      { file: "src/index.ts" },
      { filePath: "package.json" },
      { file_path: "README.md" },
      { path: "tsconfig.json" },
    ]

    for (const toolName of tools) {
      for (const args of benignCases) {
        const reason = isBlocked(toolName, args, testDir)
        expect(reason).toBeNull()
      }
    }
  })

  it("proves tool.execute.before blocks read, read_file, and fdx-read on sensitive files before execution", async () => {
    const beforeHook = pluginInstance["tool.execute.before"]
    const sessionID = "sess-sensitive-read-test"

    // 1. read with .env
    await expect(
      beforeHook({ sessionID, tool: "read", args: { file: ".env" } }, {})
    ).rejects.toThrow("blocked")

    // 2. read_file with .env
    await expect(
      beforeHook({ sessionID, tool: "read_file", args: { filePath: ".env" } }, {})
    ).rejects.toThrow("blocked")

    // 3. fdx-read with .env
    await expect(
      beforeHook({ sessionID, tool: "fdx-read", args: { file: ".env" } }, {})
    ).rejects.toThrow("blocked")

    // 4. read_file with .ssh/id_rsa
    await expect(
      beforeHook({ sessionID, tool: "read_file", args: { path: ".ssh/id_rsa" } }, {})
    ).rejects.toThrow("blocked")

    // 5. fdx-read with credentials.json
    await expect(
      beforeHook({ sessionID, tool: "fdx-read", args: { file: "credentials.json" } }, {})
    ).rejects.toThrow("blocked")

    // 6. read with /etc/passwd
    await expect(
      beforeHook({ sessionID, tool: "read", args: { file: "/etc/passwd" } }, {})
    ).rejects.toThrow("blocked")
  })

  it("allows benign file reads through tool.execute.before hook", async () => {
    const beforeHook = pluginInstance["tool.execute.before"]
    const sessionID = "sess-benign-read-test"

    // read src/index.ts
    await expect(
      beforeHook({ sessionID, tool: "read", args: { file: "src/index.ts" } }, {})
    ).resolves.toBeUndefined()

    // read_file package.json
    await expect(
      beforeHook({ sessionID, tool: "read_file", args: { filePath: "package.json" } }, {})
    ).resolves.toBeUndefined()

    // fdx-read README.md
    await expect(
      beforeHook({ sessionID, tool: "fdx-read", args: { file: "README.md" } }, {})
    ).resolves.toBeUndefined()
  })

  it("resolves relative sensitive paths against project directory", () => {
    expect(checkSensitivePath("./.env", testDir)).toBe(".env")
    expect(checkSensitivePath("subdir/../../.env", testDir)).toBe(".env")
    expect(checkSensitivePath("src/index.ts", testDir)).toBeNull()
  })
})
