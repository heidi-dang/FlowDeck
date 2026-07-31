import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { rmSync, writeFileSync, readFileSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createHash } from "crypto"
import type { ToolContext } from "@opencode-ai/plugin"
import { hashEditTool } from "../../src/tools/hash-edit"

describe("hashEditTool", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fd-hash-edit-test-"))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function makeCtx(dir: string, signal?: AbortSignal): ToolContext {
    return {
      directory: dir,
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "heidi",
      worktree: dir,
      abort: signal || new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
  }

  it("edits the file successfully when target content is found", async () => {
    const filePath = "test.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "Hello World\nThis is a test.", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "World",
        replacementContent: "Universe",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Successfully updated test.txt")
    expect(readFileSync(fullPath, "utf-8")).toBe("Hello Universe\nThis is a test.")
  })

  it("edits absolute file paths successfully", async () => {
    const fullPath = join(tempDir, "abs-test.txt")
    writeFileSync(fullPath, "Original Content", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath: fullPath,
        targetContent: "Original",
        replacementContent: "Updated",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Successfully updated")
    expect(readFileSync(fullPath, "utf-8")).toBe("Updated Content")
  })

  it("verifies MD5 hash when expectedHash is supplied", async () => {
    const filePath = "hash-test.txt"
    const fullPath = join(tempDir, filePath)
    const targetContent = "SecureTarget"
    const validHash = createHash("md5").update(targetContent).digest("hex")
    const invalidHash = "00000000000000000000000000000000"

    writeFileSync(fullPath, `Header\n${targetContent}\nFooter`, "utf-8")

    // Mismatched hash
    const failResult = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent,
        expectedHash: invalidHash,
        replacementContent: "Replaced",
      },
      makeCtx(tempDir)
    )
    expect(failResult).toContain("Error: Hash mismatch")
    expect(readFileSync(fullPath, "utf-8")).toContain(targetContent)

    // Valid hash
    const passResult = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent,
        expectedHash: validHash,
        replacementContent: "Replaced",
      },
      makeCtx(tempDir)
    )
    expect(passResult).toContain("Successfully updated")
    expect(readFileSync(fullPath, "utf-8")).toBe("Header\nReplaced\nFooter")
  })

  it("handles duplicate occurrences and counts replacements", async () => {
    const filePath = "dup.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "foo bar foo baz foo", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "foo",
        replacementContent: "qux",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("(3 replacements)")
    expect(readFileSync(fullPath, "utf-8")).toBe("qux bar qux baz qux")
  })

  it("handles replacement identical to target content", async () => {
    const filePath = "same.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "unchanged text", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "unchanged",
        replacementContent: "unchanged",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Successfully updated")
    expect(readFileSync(fullPath, "utf-8")).toBe("unchanged text")
  })

  it("handles Unicode filenames and content", async () => {
    const filePath = "测试_unicode_🚀.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "Unicode content: 你好世界 🌟", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "你好世界",
        replacementContent: "Hello World",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Successfully updated")
    expect(readFileSync(fullPath, "utf-8")).toBe("Unicode content: Hello World 🌟")
  })

  it("returns error for missing files", async () => {
    const result = await (hashEditTool.execute as any)(
      {
        filePath: "nonexistent.txt",
        targetContent: "anything",
        replacementContent: "replacement",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Error: Could not read file")
  })

  it("returns error when target content is absent from file", async () => {
    const filePath = "missing-target.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "Existing content without needle", "utf-8")

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "missing_needle",
        replacementContent: "something",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Error: Target content not found")
  })

  it("handles file mutation / concurrent deletion gracefully", async () => {
    const filePath = "mutated.txt"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, "Original text", "utf-8")

    // Delete file right before execute
    rmSync(fullPath)

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "Original",
        replacementContent: "Mutated",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Error: Could not read file")
  })

  it("handles binary / non-UTF8 files without crashing", async () => {
    const filePath = "binary.bin"
    const fullPath = join(tempDir, filePath)
    writeFileSync(fullPath, Buffer.from([0x00, 0xff, 0xfe, 0xfa]))

    const result = await (hashEditTool.execute as any)(
      {
        filePath,
        targetContent: "nonexistent_binary_str",
        replacementContent: "replacement",
      },
      makeCtx(tempDir)
    )

    expect(result).toContain("Error: Target content not found")
  })
})
