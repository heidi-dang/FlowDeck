import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  checkFdxAvailability,
  getFdxAvailabilityStatus,
  fdxReadTool,
  fdxSearchTool,
  fdxGrepTool,
  fdxBatchTool,
  fdxLsTool,
  fdxTreeTool,
  fdxDiffTool,
  fdxGitTool,
  fdxContextTool,
  fdxDecisionsTool,
} from "@/tools/fdx"
import { fdxWorktreeTool } from "@/tools/fdx-worktree"
import { fdxValidateTool } from "@/tools/fdx-validate"

let TMP: string
let ctx: any

describe("Phase 6 — FDX Reliability and Fallback", () => {
  beforeEach(() => {
    const rawTmp = join(tmpdir(), "phase6-test-" + Date.now() + "-" + Math.random().toString(36).slice(2))
    if (!existsSync(rawTmp)) mkdirSync(rawTmp, { recursive: true })
    TMP = realpathSync(rawTmp)
    ctx = { directory: TMP }
  })

  afterEach(() => {
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  })

  describe("1. FDX Availability Check & Diagnostics", () => {
    it("checkFdxAvailability returns boolean without throwing", () => {
      const avail = checkFdxAvailability(true)
      expect(typeof avail).toBe("boolean")
    })

    it("getFdxAvailabilityStatus returns structured status message", () => {
      const status = getFdxAvailabilityStatus()
      expect(typeof status.available).toBe("boolean")
      expect(typeof status.message).toBe("string")
      expect(status.message.length).toBeGreaterThan(0)
    })
  })

  describe("2. Native TS Fallbacks for Read and Search Tools", () => {
    it("fdxReadTool falls back cleanly when reading valid file", async () => {
      const file = join(TMP, "sample.ts")
      writeFileSync(file, "const a = 1;\nconst b = 2;\nconsole.log(a + b);", "utf-8")

      const res = await fdxReadTool.execute({ file, mode: "raw" }, ctx)
      expect(typeof res).toBe("string")
      expect(res).toContain("const a = 1")
    })

    it("fdxReadTool handles line limits and offsets in fallback mode", async () => {
      const file = join(TMP, "lines.txt")
      writeFileSync(file, "line1\nline2\nline3\nline4\nline5", "utf-8")

      const res = await fdxReadTool.execute({ file, mode: "raw", offset: 2, limit: 2 }, ctx)
      expect(res).toContain("line2")
      expect(res).toContain("line3")
      expect(res).not.toContain("line5")
    })

    it("fdxSearchTool & fdxGrepTool fall back cleanly without throwing", async () => {
      const sub = join(TMP, "src")
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, "app.ts"), "export function main() { return 42; }", "utf-8")

      const sRes = await fdxSearchTool.execute({ query: "main", path: TMP }, ctx)
      expect(sRes).toContain("main")

      const gRes = await fdxGrepTool.execute({ pattern: "return 42", path: TMP }, ctx)
      expect(gRes).toContain("return 42")
    })

    it("fdxBatchTool falls back cleanly to reading multiple files", async () => {
      const f1 = join(TMP, "f1.txt")
      const f2 = join(TMP, "f2.txt")
      writeFileSync(f1, "hello f1", "utf-8")
      writeFileSync(f2, "hello f2", "utf-8")

      const res = await fdxBatchTool.execute({ files: [f1, f2], mode: "raw" }, ctx)
      expect(res).toContain("hello f1")
      expect(res).toContain("hello f2")
    })
  })

  describe("3. Native TS Fallbacks for Directory, Git, Context & Decision Tools", () => {
    it("fdxLsTool & fdxTreeTool fall back cleanly to directory listing", async () => {
      mkdirSync(join(TMP, "dirA"), { recursive: true })
      writeFileSync(join(TMP, "fileA.txt"), "data", "utf-8")

      const lsRes = await fdxLsTool.execute({ path: TMP }, ctx)
      expect(lsRes).toContain("dirA")
      expect(lsRes).toContain("fileA.txt")

      const treeRes = await fdxTreeTool.execute({ path: TMP }, ctx)
      expect(treeRes).toContain("dirA")
    })

    it("fdxDiffTool & fdxGitTool fall back cleanly without process failure", async () => {
      const gitRes = await fdxGitTool.execute({ subcommand: "version" }, ctx)
      expect(typeof gitRes).toBe("string")

      const diffRes = await fdxDiffTool.execute({}, ctx)
      expect(typeof diffRes).toBe("string")
    })

    it("fdxContextTool & fdxDecisionsTool fall back cleanly to planning state locks", async () => {
      const appendRes = await fdxContextTool.execute(
        {
          action: "append",
          topic: "t-phase6",
          agent: "heidi",
          stage: "execute",
          summary: "Execution complete",
        },
        ctx
      )
      expect(typeof appendRes).toBe("string")

      const readRes = await fdxContextTool.execute(
        {
          action: "read",
          topic: "t-phase6",
        },
        ctx
      )
      expect(typeof readRes).toBe("string")

      const recordRes = await fdxDecisionsTool.execute(
        {
          action: "record",
          topic: "t-phase6",
          decision: "Use native TS fallback",
          rationale: "Ensures reliability without binary dependency",
        },
        ctx
      )
      expect(typeof recordRes).toBe("string")
    })
  })

  describe("4. Reliability of Worktree and Validation Tools", () => {
    it("fdxWorktreeTool rejects missing or invalid phase arguments cleanly", async () => {
      const res = await fdxWorktreeTool.execute({ action: "create", topic: "test-topic", phase: NaN as any }, ctx)
      expect(res).toContain("phase must be an integer")
    })

    it("fdxValidateTool reports errors for invalid topics cleanly", async () => {
      const res = await fdxValidateTool.execute({ action: "pre-execute", topic: "nonexistent-topic-12345" }, ctx)
      expect(res).toContain("task.md missing")
    })
  })
})
