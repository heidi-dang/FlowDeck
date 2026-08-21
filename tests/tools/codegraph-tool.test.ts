import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test"
import { codegraphTool } from "../../src/tools/codegraph-tool"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import * as childProcess from "child_process"
import type { SpawnSyncReturns } from "child_process"

function spawn(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { status, stdout, stderr, pid: 0, output: [null, stdout, stderr], signal: null }
}

const TEST_DIR = join(__dirname, ".test-codegraph-tool")

function parseToolResult(result: unknown): any {
  if (typeof result === "string") return JSON.parse(result)
  if (result && typeof result === "object" && "output" in result) return JSON.parse((result as any).output)
  return result
}

describe("codegraph tool", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
    spawnSpy = vi.spyOn(childProcess, "spawnSync")
  })

  afterEach(() => {
    spawnSpy.mockRestore()
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  })

  it("handles check action", async () => {
    spawnSpy.mockReturnValue(spawn(1))
    const res = await codegraphTool.execute({ action: "check" }, { directory: TEST_DIR } as any)
    const data = parseToolResult(res)
    expect(data.installed).toBe(false)
    expect(data.recommendation).toContain("run action=install")
  })

  it("handles install action success and failure", async () => {
    spawnSpy.mockImplementation((cmd: string) => {
      if (cmd === "codegraph") return spawn(1)
      return spawn(0, "installed ok")
    })
    const res = await codegraphTool.execute({ action: "install" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(res).success).toBe(true)

    spawnSpy.mockImplementation((cmd: string) => {
      if (cmd === "codegraph") return spawn(1)
      return spawn(1, "", "install failed")
    })
    const failRes = await codegraphTool.execute({ action: "install" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(failRes).success).toBe(false)
  })

  it("handles init action success and failure", async () => {
    spawnSpy.mockReturnValue(spawn(0, "init ok"))
    const res = await codegraphTool.execute({ action: "init" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(res).success).toBe(true)

    spawnSpy.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args && args.includes("--index")) return spawn(1, "", "init error")
      return spawn(0, "ok")
    })
    const failRes = await codegraphTool.execute({ action: "init" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(failRes).success).toBe(false)
  })

  it("handles refresh action success and failure", async () => {
    spawnSpy.mockReturnValue(spawn(0, "refresh ok"))
    const res = await codegraphTool.execute({ action: "refresh" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(res).success).toBe(true)

    spawnSpy.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args && args.includes("--index")) return spawn(1, "", "refresh error")
      return spawn(0, "ok")
    })
    const failRes = await codegraphTool.execute({ action: "refresh" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(failRes).success).toBe(false)
  })

  it("handles status action", async () => {
    spawnSpy.mockReturnValue(spawn(0, "version 1.0.0"))
    const res = await codegraphTool.execute({ action: "status" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(res).installed).toBe(true)
  })

  it("handles mark-stale action", async () => {
    const res = await codegraphTool.execute({ action: "mark-stale" }, { directory: TEST_DIR } as any)
    expect(parseToolResult(res).success).toBe(true)
  })

  it("rejects unknown action", async () => {
    const res = await codegraphTool.execute({ action: "invalid" as any }, { directory: TEST_DIR } as any)
    const str = typeof res === "string" ? res : (res as any)?.output ?? ""
    expect(str).toContain("Unknown action")
  })
})
