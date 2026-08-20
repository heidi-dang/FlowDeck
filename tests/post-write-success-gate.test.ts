import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { mkdirSync, rmSync } from "fs"
import flowDeckPlugin, { getSessionMetricsDiagnostics } from "../src/index"

describe("Post-Write Success Gate and Lifecycle Regressions", () => {
  const testDir = join(tmpdir(), "post-write-lifecycle-" + Date.now())
  let pluginInstance: any

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    pluginInstance = await (flowDeckPlugin as any).server({
      directory: testDir,
      client: { app: { log: async () => {} } } as any,
    })
  })

  afterEach(async () => {
    if (pluginInstance?.dispose) await pluginInstance.dispose()
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it("proves read tools with file arguments never trigger post-write tracking or verification", async () => {
    const sessionID = "sess-read-gate-1"
    const afterHook = pluginInstance["tool.execute.after"]

    // Execute successful read tool
    await afterHook(
      { sessionID, tool: "read", args: { file: "src/index.ts" } },
      { output: "file contents", error: null }
    )

    // Execute successful fdx-read tool
    await afterHook(
      { sessionID, tool: "fdx-read", args: { file: "src/index.ts" } },
      { output: "fdx contents", error: null }
    )

    // Execute successful read_file tool
    await afterHook(
      { sessionID, tool: "read_file", args: { filePath: "src/index.ts" } },
      { output: "file contents", error: null }
    )

    const metrics = getSessionMetricsDiagnostics(sessionID)
    expect(metrics.filesChangedCount).toBe(0)
  })

  it("proves failed writes never increment changed files or verification", async () => {
    const sessionID = "sess-fail-write-1"
    const afterHook = pluginInstance["tool.execute.after"]

    // 1. Thrown tool error on write
    await afterHook(
      { sessionID, tool: "write_file", args: { filePath: "src/failed1.ts" }, error: new Error("Disk full") },
      {}
    )

    // 2. Structured error property on toolOutput
    await afterHook(
      { sessionID, tool: "edit", args: { file: "src/failed2.ts" } },
      { error: "Match not found", output: null }
    )

    const metrics = getSessionMetricsDiagnostics(sessionID)
    expect(metrics.filesChangedCount).toBe(0)
  })

  it("proves successful mutating tools track exactly once across supported mutation tool names", async () => {
    const mutatingTools = [
      { tool: "write", args: { file: "src/file1.ts" } },
      { tool: "write_file", args: { filePath: "src/file2.ts" } },
      { tool: "edit", args: { file: "src/file3.ts" } },
      { tool: "patch", args: { path: "src/file4.ts" } },
      { tool: "apply_patch", args: { file_path: "src/file5.ts" } },
      { tool: "str_replace", args: { filePath: "src/file6.ts" } },
      { tool: "hash-edit", args: { filePath: "src/file7.ts" } },
      { tool: "create_file", args: { path: "src/file8.ts" } },
    ]

    const sessionID = "sess-mut-tools-1"
    const afterHook = pluginInstance["tool.execute.after"]

    for (const { tool, args } of mutatingTools) {
      await afterHook(
        { sessionID, tool, args },
        { output: "success", error: null }
      )
    }

    const metrics = getSessionMetricsDiagnostics(sessionID)
    expect(metrics.filesChangedCount).toBe(mutatingTools.length)
  })

  it("handles failed write followed by successful retry resulting in exactly one file tracked", async () => {
    const sessionID = "sess-retry-write-1"
    const afterHook = pluginInstance["tool.execute.after"]
    const filePath = "src/component.tsx"

    // Initial failed write
    await afterHook(
      { sessionID, tool: "write_file", args: { filePath } },
      { error: new Error("EACCES"), output: null }
    )

    let metrics = getSessionMetricsDiagnostics(sessionID)
    expect(metrics.filesChangedCount).toBe(0)

    // Successful retry
    await afterHook(
      { sessionID, tool: "write_file", args: { filePath } },
      { output: "written", error: null }
    )

    metrics = getSessionMetricsDiagnostics(sessionID)
    expect(metrics.filesChangedCount).toBe(1)
  })
})
