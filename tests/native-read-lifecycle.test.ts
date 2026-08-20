import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import flowDeckPlugin from "../src/index"
import { fdxReadTool } from "../src/tools/fdx"
import { setNativeReadFallbackListenerForTest } from "../src/tools/fdx-shared"
import { setFdxAvailableOverrideForTest } from "../src/hooks/session-start"

describe("Native Read -> FDX Execution Lifecycle Integration", () => {
  const testDir = join(tmpdir(), "fdx-read-lifecycle-" + Date.now())
  const sampleFile = "sample.ts"
  const samplePath = join(testDir, sampleFile)
  let pluginInstance: any
  let origFdxExecute: any

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(samplePath, "export const alpha = 1;\nexport const beta = 2;\n")
    origFdxExecute = fdxReadTool.execute
    pluginInstance = await (flowDeckPlugin as any).server({
      directory: testDir,
      client: { app: { log: async () => {} } } as any,
    })
  })

  afterEach(async () => {
    fdxReadTool.execute = origFdxExecute
    setFdxAvailableOverrideForTest(null)
    setNativeReadFallbackListenerForTest(null)
    if (pluginInstance?.dispose) await pluginInstance.dispose()
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
    delete process.env.FLOWDECK_ENFORCE_FDX_REDIRECT
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
    delete process.env.FDX_DISABLE_FALLBACK
  })

  it("Case A: FDX Enforcement ON + FDX available + fallback disabled -> FDX succeeds (fdx=1, fallback=0)", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    process.env.FDX_DISABLE_FALLBACK = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

    let fdxCallCount = 0
    let fallbackCallCount = 0

    setFdxAvailableOverrideForTest(true)
    setNativeReadFallbackListenerForTest(() => {
      fallbackCallCount++
    })

    fdxReadTool.execute = async (args: any) => {
      fdxCallCount++
      return "[FDX Output] " + args.file
    }

    const readTool = pluginInstance.tool["read"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile, mode: "auto" },
      { sessionID: "sess-read-case-a" }
    )

    expect(fdxCallCount).toBe(1)
    expect(fallbackCallCount).toBe(0)
    expect(result).toBe("[FDX Output] " + sampleFile)
  })

  it("Case B: FDX Enforcement ON + FDX available + fallback disabled -> FDX execution fails (fdx=1, fallback=0, throw)", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    process.env.FDX_DISABLE_FALLBACK = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

    let fdxCallCount = 0
    let fallbackCallCount = 0

    setFdxAvailableOverrideForTest(true)
    setNativeReadFallbackListenerForTest(() => {
      fallbackCallCount++
    })

    fdxReadTool.execute = async () => {
      fdxCallCount++
      throw new Error("Simulated FDX binary crash")
    }

    const readTool = pluginInstance.tool["read_file"]
    expect(readTool).toBeDefined()

    await expect(
      readTool.execute({ file: sampleFile }, { sessionID: "sess-read-case-b" })
    ).rejects.toThrow("Simulated FDX binary crash")

    expect(fdxCallCount).toBe(1)
    expect(fallbackCallCount).toBe(0)
  })

  it("Case C: FDX Enforcement ON + FDX unavailable + fallback disabled (fallback=0, throw clear error)", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    process.env.FDX_DISABLE_FALLBACK = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

    let fallbackCallCount = 0
    setFdxAvailableOverrideForTest(false)
    setNativeReadFallbackListenerForTest(() => {
      fallbackCallCount++
    })

    const readTool = pluginInstance.tool["read"]
    expect(readTool).toBeDefined()

    await expect(
      readTool.execute({ file: sampleFile }, { sessionID: "sess-read-case-c" })
    ).rejects.toThrow("[FDX Fallback Disabled]")

    expect(fallbackCallCount).toBe(0)
  })

  it("Case D: FDX Enforcement ON + FDX execution fails + fallback enabled -> exactly one native fallback", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
    delete process.env.FDX_DISABLE_FALLBACK

    let fdxCallCount = 0
    let fallbackCallCount = 0

    setFdxAvailableOverrideForTest(true)
    setNativeReadFallbackListenerForTest(() => {
      fallbackCallCount++
    })

    fdxReadTool.execute = async () => {
      fdxCallCount++
      throw new Error("Simulated FDX daemon glitch")
    }

    const readTool = pluginInstance.tool["read_file"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile },
      { sessionID: "sess-read-case-d" }
    )

    expect(fdxCallCount).toBe(1)
    expect(fallbackCallCount).toBe(1)
    expect(result).toContain("export const alpha = 1;")
  })

  it("Case E: FDX Redirect disabled -> executes native read directly with 0 FDX calls", async () => {
    process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_ENFORCE_FDX_REDIRECT

    let fdxCallCount = 0
    let fallbackCallCount = 0

    setNativeReadFallbackListenerForTest(() => {
      fallbackCallCount++
    })

    fdxReadTool.execute = async () => {
      fdxCallCount++
      return "[FDX Output]"
    }

    const readTool = pluginInstance.tool["read"]
    expect(readTool).toBeDefined()

    const result = await readTool.execute(
      { file: sampleFile },
      { sessionID: "sess-read-case-e" }
    )

    expect(fdxCallCount).toBe(0)
    expect(fallbackCallCount).toBe(1)
    expect(result).toContain("export const alpha = 1;")
  })

  it("proves both read and read_file use identical routing semantics", async () => {
    process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
    delete process.env.FDX_DISABLE_FALLBACK

    let fdxCallCount = 0
    setFdxAvailableOverrideForTest(true)
    fdxReadTool.execute = async (args: any) => {
      fdxCallCount++
      return "[FDX Result] " + args.file
    }

    const r1 = await pluginInstance.tool["read"].execute({ file: sampleFile }, { sessionID: "sess-ident-1" })
    const r2 = await pluginInstance.tool["read_file"].execute({ filePath: sampleFile }, { sessionID: "sess-ident-2" })

    expect(fdxCallCount).toBe(2)
    expect(r1).toBe("[FDX Result] " + sampleFile)
    expect(r2).toBe("[FDX Result] " + sampleFile)
  })
})
