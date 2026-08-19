import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import flowDeckPlugin from "../src/index"
import { fdxReadTool } from "../src/tools/fdx"

describe("Native Read -> FDX Execution Lifecycle Integration", () => {
  const testDir = join(tmpdir(), "fdx-read-lifecycle-" + Date.now())
  const sampleFile = "sample.ts"
  const samplePath = join(testDir, sampleFile)
  let pluginInstance: any

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(samplePath, "export const alpha = 1;\nexport const beta = 2;\n")
    pluginInstance = await (flowDeckPlugin as any).server({
      directory: testDir,
      client: { app: { log: async () => {} } } as any,
    })
  })

  afterEach(async () => {
    if (pluginInstance?.dispose) await pluginInstance.dispose()
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
    delete process.env.FLOWDECK_ENFORCE_FDX_REDIRECT
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
  })

  it("executes through fdxReadTool with 0 native fallback calls when FDX enforcement is ON and FDX is available", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

    let fdxCallCount = 0
    const origFdxExecute = fdxReadTool.execute

    fdxReadTool.execute = async (args: any) => {
      fdxCallCount++
      return "[FDX Output] " + args.file
    }

    const readTool = pluginInstance.tool["read"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile, mode: "auto" },
      { sessionID: "sess-read-1" }
    )

    fdxReadTool.execute = origFdxExecute

    expect(fdxCallCount).toBe(1)
    expect(result).toBe("[FDX Output] " + sampleFile)
  })

  it("executes native read directly with 0 FDX calls when FDX redirect is OFF", async () => {
    process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_ENFORCE_FDX_REDIRECT

    let fdxCallCount = 0
    const origFdxExecute = fdxReadTool.execute
    fdxReadTool.execute = async () => {
      fdxCallCount++
      return "[FDX Output]"
    }

    const readTool = pluginInstance.tool["read"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile },
      { sessionID: "sess-read-2" }
    )

    fdxReadTool.execute = origFdxExecute

    expect(fdxCallCount).toBe(0)
    expect(result).toContain("export const alpha = 1;")
  })

  it("applies exactly one bounded fallback with no recursion when FDX execution fails", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

    let fdxCallCount = 0
    const origFdxExecute = fdxReadTool.execute

    fdxReadTool.execute = async () => {
      fdxCallCount++
      throw new Error("Simulated FDX daemon crash")
    }

    const readTool = pluginInstance.tool["read_file"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile },
      { sessionID: "sess-read-3" }
    )

    fdxReadTool.execute = origFdxExecute

    expect(fdxCallCount).toBe(1)
    expect(result).toContain("export const alpha = 1;")
  })
})
