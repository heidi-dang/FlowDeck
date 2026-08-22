import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codebaseStateTool } from "../src/tools/codebase-state"
import { resolveCodebasePath, PathTraversalError } from "../src/tools/path-jail"

describe("P0 Security: .codebase path traversal & arbitrary read/write containment", () => {
  let testWorkspace: string
  let outsideDir: string
  let outsideSecretFile: string

  beforeEach(() => {
    testWorkspace = realpathSync(mkdtempSync(join(tmpdir(), "fd-codebase-jail-test-")))
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "fd-outside-dir-")))
    outsideSecretFile = join(outsideDir, "secret.txt")
    writeFileSync(outsideSecretFile, "TOP_SECRET_DATA", "utf-8")

    const codebaseDir = join(testWorkspace, ".codebase")
    mkdirSync(codebaseDir, { recursive: true })
    writeFileSync(join(codebaseDir, "ARCHITECTURE.md"), "# Architecture", "utf-8")
  })

  afterEach(() => {
    try { rmSync(testWorkspace, { recursive: true, force: true }) } catch {}
    try { rmSync(outsideDir, { recursive: true, force: true }) } catch {}
  })

  describe("resolveCodebasePath containment primitive", () => {
    it("allows valid relative files inside .codebase", () => {
      const p = resolveCodebasePath(testWorkspace, "ARCHITECTURE.md")
      expect(p).toBe(join(testWorkspace, ".codebase", "ARCHITECTURE.md"))
    })

    it("allows valid nested subdirectories inside .codebase", () => {
      const p = resolveCodebasePath(testWorkspace, "sub/deep/doc.md", { forWrite: true })
      expect(p).toBe(join(testWorkspace, ".codebase", "sub", "deep", "doc.md"))
    })

    it("rejects absolute paths", () => {
      expect(() => resolveCodebasePath(testWorkspace, "/etc/passwd")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, outsideSecretFile)).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "C:\\Windows\\System32")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "\\\\server\\share\\file.txt")).toThrow(PathTraversalError)
    })

    it("rejects lexical path traversal escapes", () => {
      expect(() => resolveCodebasePath(testWorkspace, "../package.json")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "../../outside.txt")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "sub/../../../../outside.txt")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "sub/nested/../../../outside.txt")).toThrow(PathTraversalError)
    })

    it("rejects mixed separators and Windows-style paths", () => {
      expect(() => resolveCodebasePath(testWorkspace, "..\\..\\outside.txt")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "sub/..\\..\\..\\outside.txt")).toThrow(PathTraversalError)
      expect(() => resolveCodebasePath(testWorkspace, "sub\\../..\\..\\outside.txt")).toThrow(PathTraversalError)
    })

    it("rejects prefix collision escapes", () => {
      // e.g. .codebase-other outside of .codebase
      expect(() => resolveCodebasePath(testWorkspace, "../.codebase-other/test.md")).toThrow(PathTraversalError)
    })

    it("rejects symlink escape on read", () => {
      const symlinkPath = join(testWorkspace, ".codebase", "escaped_symlink.md")
      try {
        symlinkSync(outsideSecretFile, symlinkPath)
      } catch {
        return // skip if symlink creation not supported on OS/privileges
      }
      expect(() => resolveCodebasePath(testWorkspace, "escaped_symlink.md", { mustExist: true })).toThrow(PathTraversalError)
    })

    it("rejects parent-symlink escape on write", () => {
      const symlinkParent = join(testWorkspace, ".codebase", "symlink_dir")
      try {
        symlinkSync(outsideDir, symlinkParent, "dir")
      } catch {
        return
      }
      expect(() => resolveCodebasePath(testWorkspace, "symlink_dir/pwned.md", { forWrite: true })).toThrow(PathTraversalError)
    })
  })

  describe("codebaseStateTool action execution", () => {
    it("reads valid codebase files", async () => {
      const resStr: any = await (codebaseStateTool as any).execute({
        action: "read",
        files: ["ARCHITECTURE.md"],
      }, { directory: testWorkspace } as any)
      const res = JSON.parse(typeof resStr === "string" ? resStr : resStr.output)
      expect(res["ARCHITECTURE.md"]).toBe("# Architecture")
    })

    it("refuses to read outside .codebase via traversal or absolute path", async () => {
      const resStr: any = await (codebaseStateTool as any).execute({
        action: "read",
        files: [
          "../../outside.txt",
          "/etc/passwd",
          "sub/../../../etc/shadow",
          "..\\..\\outside.txt",
        ],
      }, { directory: testWorkspace } as any)
      const res = JSON.parse(typeof resStr === "string" ? resStr : resStr.output)
      for (const key of Object.keys(res)) {
        expect(res[key]).toHaveProperty("error")
      }
    })

    it("refuses to write outside .codebase via traversal or absolute path", async () => {
      const targetOutside = join(outsideDir, "attack_written.txt")
      const resStr: any = await (codebaseStateTool as any).execute({
        action: "write",
        filename: "../../outside_attack.txt",
        content: "malicious data",
      }, { directory: testWorkspace } as any)
      const res = JSON.parse(typeof resStr === "string" ? resStr : resStr.output)
      expect(res.success).toBe(false)
      expect(res.error).toBeDefined()
      expect(existsSync(join(testWorkspace, "..", "outside_attack.txt"))).toBe(false)
      expect(existsSync(targetOutside)).toBe(false)
    })

    it("refuses to write through symlinked directory escaping .codebase", async () => {
      const symlinkParent = join(testWorkspace, ".codebase", "escape_dir")
      try {
        symlinkSync(outsideDir, symlinkParent, "dir")
      } catch {
        return
      }

      const resStr: any = await (codebaseStateTool as any).execute({
        action: "write",
        filename: "escape_dir/hacked.txt",
        content: "pwned",
      }, { directory: testWorkspace } as any)
      const res = JSON.parse(typeof resStr === "string" ? resStr : resStr.output)
      expect(res.success).toBe(false)
      expect(existsSync(join(outsideDir, "hacked.txt"))).toBe(false)
    })

    it("writes valid files safely inside .codebase", async () => {
      const resStr: any = await (codebaseStateTool as any).execute({
        action: "write",
        filename: "SUB/TEST.md",
        content: "# Nested Test",
      }, { directory: testWorkspace } as any)
      const res = JSON.parse(typeof resStr === "string" ? resStr : resStr.output)
      expect(res.success).toBe(true)
      expect(readFileSync(join(testWorkspace, ".codebase", "SUB", "TEST.md"), "utf-8")).toBe("# Nested Test")
    })
  })
})
