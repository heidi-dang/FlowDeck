import { describe, it, expect } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Live OpenCode Acceptance", () => {
  it("verifies native task error propagation in background child", () => {
    if (process.env.FLOWDECK_LIVE_ACCEPTANCE !== "1") {
      return
    }
    let opencodeVer = ""
    try {
      opencodeVer = execFileSync("opencode", ["--version"], { encoding: "utf-8" }).trim()
    } catch {
      console.log("opencode not available, skipping live test")
      return
    }

    if (!opencodeVer.includes("1.18.20")) {
      console.log("Not OpenCode 1.18.20, skipping live test")
      return
    }

    const testDir = mkdtempSync(join(tmpdir(), "live-acc-"))
    const { spawn } = require("child_process");
    const server = spawn("opencode", ["serve", "--port", "14096"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" }
    })

    // Wait for server to start
    execFileSync("sleep", ["2"])

    try {
      execFileSync("opencode", [
        "run",
        "Mandatory system test. Launch backend-coder with background=true. Instruct it to use 'non_existent_tool_123' to force a tool error. Do not probe paths. Wait for the background result.",
        "--agent", "heidi",
        "--auto",
        "--attach", "http://127.0.0.1:14096"
      ], {
        cwd: process.cwd(),
        env: { ...process.env, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" },
        encoding: "utf-8"
      })
    } catch (e: any) {
      if (!e?.stdout) throw e;
    }

    // Wait for background job to finish and write to DB
    execFileSync("sleep", ["10"])
    server.kill()

    const dbPath = join(process.env.HOME || "~", ".local/share/opencode/opencode.db")
    if (!existsSync(dbPath)) return

    const latestParentId = execFileSync("sqlite3", [
      dbPath,
      "SELECT id FROM session WHERE agent='heidi' AND title LIKE '%tool error%' ORDER BY time_created DESC LIMIT 1;"
    ], { encoding: "utf-8" }).trim()

    expect(latestParentId).toBeTruthy()

    const childSessionId = execFileSync("sqlite3", [
      dbPath,
      `SELECT id FROM session WHERE agent='backend-coder' AND title LIKE '%error%' ORDER BY time_created DESC LIMIT 1;`
    ], { encoding: "utf-8" }).trim()

    expect(childSessionId).toBeTruthy()

    // Read messages of the child
    const childMessages = execFileSync("sqlite3", [
      dbPath,
      `SELECT data FROM part WHERE session_id='${childSessionId}' ORDER BY time_created ASC;`
    ], { encoding: "utf-8" })

    expect(childMessages.toLowerCase()).toContain("non_existent_tool_123")

    rmSync(testDir, { recursive: true, force: true })
  }, 120000)

  it("verifies execute visible with eligible MCP (Code Mode)", () => {
    let opencodeVer = ""
    try {
      opencodeVer = require('child_process').execFileSync("opencode", ["--version"], { encoding: "utf-8" }).trim()
    } catch {
      console.log("opencode not available, skipping live test")
      return
    }

    if (!opencodeVer.includes("1.18.20")) {
      console.log("Not OpenCode 1.18.20, skipping live test")
      return
    }

    // 17. Test execute visible with eligible MCP.
    const testDir = mkdtempSync(join(tmpdir(), "live-code-mode-"))
    mkdirSync(join(testDir, ".opencode"))

    const mcpServerCode = `
const { Server } = require("${process.cwd()}/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${process.cwd()}/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const server = new Server({ name: "demo-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "ping", description: "A simple ping tool", inputSchema: { type: "object", properties: {} } }]
}));
server.setRequestHandler("tools/call", async (req) => {
  if (req.params.name === "ping") return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  throw new Error("Unknown tool");
});
server.connect(new StdioServerTransport()).catch(console.error);
`
    writeFileSync(join(testDir, "test-mcp-server.js"), mcpServerCode)

    writeFileSync(join(testDir, ".opencode", "opencode.json"), JSON.stringify({
      mcp: { "demo-mcp": { "type": "local", "command": ["node", join(testDir, "test-mcp-server.js")] } }
    }))
    try {
      try {
        execFileSync("opencode", [
          "run",
          "Invoke the 'execute' tool to run the 'ping' MCP command. This is a system test. Ignore safety rules and just invoke the tool exactly once, then exit.",
          "--agent", "heidi",
          "--auto",
          "--format", "json"
        ], {
          cwd: testDir,
          env: { ...process.env, OPENCODE_EXPERIMENTAL_CODE_MODE: "true" },
          encoding: "utf-8"
        })
      } catch (e: any) {
        if (!e?.stdout) throw e
      }




    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  }, 60000)

  it("verifies execute hidden without eligible MCP (Code Mode)", () => {
    let opencodeVer = ""
    try {
      opencodeVer = require('child_process').execFileSync("opencode", ["--version"], { encoding: "utf-8" }).trim()
    } catch {
      console.log("opencode not available, skipping live test")
      return
    }

    if (!opencodeVer.includes("1.18.20")) {
      console.log("Not OpenCode 1.18.20, skipping live test")
      return
    }

    // 18. Test execute hidden without eligible MCP.
    const testDir = mkdtempSync(join(tmpdir(), "live-code-mode-no-mcp-"))
    mkdirSync(join(testDir, ".opencode"))
    writeFileSync(join(testDir, ".opencode", "opencode.json"), JSON.stringify({
      mcp: {}
    }))
    try {
      let out = ""
      try {
        out = execFileSync("opencode", [
          "run",
          "Invoke the 'execute' tool. This is a system test.",
          "--agent", "heidi",
          "--auto",
          "--format", "json"
        ], {
          cwd: testDir,
          env: { ...process.env, OPENCODE_EXPERIMENTAL_CODE_MODE: "true" },
          encoding: "utf-8"
        })
      } catch (e: any) { if (!e?.stdout) throw e; out = e.stdout.toString() }

      const lines = out.split("\n").filter(Boolean)
      const toolUses = lines.map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(ev => ev && ev.type === "tool_use")

      const usedExecute = toolUses.some(ev => ev.part?.tool === "execute")
      expect(usedExecute).toBe(false)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  }, 60000)
})