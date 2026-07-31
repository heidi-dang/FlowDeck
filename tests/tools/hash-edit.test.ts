import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { createHash } from "crypto"
import type { ToolContext } from "@opencode-ai/plugin"
import { hashEditTool } from "@/tools/hash-edit"

const TMP = join(process.cwd(), ".test-tmp-hashedit")

function makeCtx(): ToolContext {
  return {
    directory: TMP,
    sessionID: "test",
    messageID: "test",
    agent: "test",
    worktree: TMP,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

describe("hashEditTool", () => {
  it("edits the file successfully when target content is found", async () => {
    const filePath = "test.txt"
    const fullPath = join(TMP, filePath)
    writeFileSync(fullPath, "Hello World\nThis is a test.", "utf-8")

    const result = await hashEditTool.execute(
      {
        filePath,
        targetContent: "World",
        replacementContent: "Universe",
      },
      makeCtx()
    )

    expect(result).toContain("Successfully updated test.txt")
    expect(readFileSync(fullPath, "utf-8")).toBe("Hello Universe\nThis is a test.")
  })

  it("fails when the file cannot be read", async () => {
    const result = await hashEditTool.execute(
      {
        filePath: "nonexistent.txt",
        targetContent: "World",
        replacementContent: "Universe",
      },
      makeCtx()
    )

    expect(result).toContain("Error: Could not read file nonexistent.txt")
  })

  it("fails when target content is not found", async () => {
    const filePath = "test.txt"
    const fullPath = join(TMP, filePath)
    writeFileSync(fullPath, "Hello World", "utf-8")

    const result = await hashEditTool.execute(
      {
        filePath,
        targetContent: "Universe",
        replacementContent: "Galaxy",
      },
      makeCtx()
    )

    expect(result).toContain("Error: Target content not found in test.txt")
  })

  it("edits the file successfully when expected hash matches", async () => {
    const filePath = "test.txt"
    const fullPath = join(TMP, filePath)
    writeFileSync(fullPath, "Hello World", "utf-8")
    const expectedHash = createHash("md5").update("World").digest("hex")

    const result = await hashEditTool.execute(
      {
        filePath,
        targetContent: "World",
        expectedHash,
        replacementContent: "Universe",
      },
      makeCtx()
    )

    expect(result).toContain("Successfully updated test.txt")
    expect(readFileSync(fullPath, "utf-8")).toBe("Hello Universe")
  })

  it("fails when expected hash does not match", async () => {
    const filePath = "test.txt"
    const fullPath = join(TMP, filePath)
    writeFileSync(fullPath, "Hello World", "utf-8")

    const result = await hashEditTool.execute(
      {
        filePath,
        targetContent: "World",
        expectedHash: "invalidhash123",
        replacementContent: "Universe",
      },
      makeCtx()
    )

    expect(result).toContain("Error: Hash mismatch for target content")
    expect(readFileSync(fullPath, "utf-8")).toBe("Hello World")
  })

  it("replaces multiple occurrences correctly", async () => {
    const filePath = "test.txt"
    const fullPath = join(TMP, filePath)
    writeFileSync(fullPath, "World Hello World", "utf-8")

    const result = await hashEditTool.execute(
      {
        filePath,
        targetContent: "World",
        replacementContent: "Universe",
      },
      makeCtx()
    )

    expect(result).toContain("Successfully updated test.txt using hash-anchored edit (2 replacements)")
    expect(readFileSync(fullPath, "utf-8")).toBe("Universe Hello Universe")
  })
})
