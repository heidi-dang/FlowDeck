import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { codebaseStateTool, codebaseDir } from "../src/tools/codebase-state"
import { mkdtempSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Codebase State Tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codebase-test-"))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it("computes codebase directory path", () => {
    expect(codebaseDir("/test/path")).toBe(join("/test/path", ".codebase"))
  })

  it("checks existence when directory does not exist", async () => {
    const resStr = await (codebaseStateTool as any).execute({ action: "exists" }, { directory: tmpDir })
    const res = JSON.parse(resStr)
    expect(res.exists).toBe(false)
    expect(res.files).toEqual([])
  })

  it("writes files, lists them, and reads them", async () => {
    // Write a file
    const writeResStr = await (codebaseStateTool as any).execute(
      { action: "write", filename: "ARCH.md", content: "# Architecture\nContent here" },
      { directory: tmpDir }
    )
    const writeRes = JSON.parse(writeResStr)
    expect(writeRes.success).toBe(true)
    expect(writeRes.file).toBe("ARCH.md")

    // Check existence
    const existsResStr = await (codebaseStateTool as any).execute({ action: "exists" }, { directory: tmpDir })
    const existsRes = JSON.parse(existsResStr)
    expect(existsRes.exists).toBe(true)
    expect(existsRes.files).toContain("ARCH.md")

    // Read existing and non-existing files
    const readResStr = await (codebaseStateTool as any).execute(
      { action: "read", files: ["ARCH.md", "NON_EXISTENT.md"] },
      { directory: tmpDir }
    )
    const readRes = JSON.parse(readResStr)
    expect(readRes["ARCH.md"]).toBe("# Architecture\nContent here")
    expect(readRes["NON_EXISTENT.md"]).toEqual({ error: "File not found: NON_EXISTENT.md" })
  })

  it("handles directory error when reading", async () => {
    // Create a subfolder inside .codebase
    const cbDir = codebaseDir(tmpDir)
    mkdirSync(join(cbDir, "subfolder"), { recursive: true })

    const readResStr = await (codebaseStateTool as any).execute(
      { action: "read", files: ["subfolder"] },
      { directory: tmpDir }
    )
    const readRes = JSON.parse(readResStr)
    expect(readRes["subfolder"].error).toContain("Is a directory: subfolder")
  })
})
