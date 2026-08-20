import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { OrchestratorGuard } from "../src/hooks/orchestrator-guard-hook"
import { isSafeTemporaryRm, executeFdxRedirect } from "../src/hooks/tool-guard"
import { checkFdxAvailability } from "../src/tools/fdx-shared"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, unlinkSync } from "fs"

describe("Audit Repair Regression Suite — Security & Policy Invariants", () => {
  const guard = new OrchestratorGuard()

  // ── A. Shell failure-probe authorization bypass removal ────────────────────
  describe("A: Shell failure-probe authorization bypass", () => {
    it("rejects mutating commands even when probe metadata is present", async () => {
      const probeArgs = {
        command: "rm -rf src/",
        description: "deliberate exit 17 test probe",
        expectedExitCode: 17,
      }
      expect(() =>
        guard.check(
          "sess-probe-1",
          "bash",
          probeArgs,
          "heidi"
        )
      ).toThrow()
    })

    it("rejects git commit with probe description", async () => {
      const commitArgs = {
        command: "git commit -m 'test'",
        description: "audit failure probe",
        expectedExitCodes: [1, 17],
      }
      expect(() =>
        guard.check(
          "sess-probe-2",
          "bash",
          commitArgs,
          "heidi"
        )
      ).toThrow()
    })

    it("rejects sensitive reads with probe metadata", async () => {
      const sensitiveArgs = {
        command: "cat .env",
        description: "failure probe check",
        expectedExitCode: 17,
      }
      expect(() =>
        guard.check(
          "sess-probe-3",
          "bash",
          sensitiveArgs,
          "heidi"
        )
      ).toThrow()
    })

    it("allows valid read-only command with probe metadata", async () => {
      const readArgs = {
        command: "git status",
        description: "status probe",
        expectedExitCode: 0,
      }
      expect(() =>
        guard.check(
          "sess-probe-4",
          "bash",
          readArgs,
          "heidi"
        )
      ).not.toThrow()
    })
  })

  // ── B. Sensitive-path bypass removal across multiple utilities ─────────────
  describe("B: Sensitive-path checks across unix utilities", () => {
    const readUtilities = ["cat", "head", "tail", "cut", "grep"]
    const sensitiveFiles = [".env", ".env.local", ".ssh/id_rsa", "/etc/passwd", "credentials.json"]

    for (const util of readUtilities) {
      for (const file of sensitiveFiles) {
        it(`blocks ${util} on ${file} as sensitive-read`, () => {
          const cmd = util === "grep" ? `grep pattern ${file}` : `${util} ${file}`
          const res = classifyShellCommand(cmd)
          expect(res.category).toBe("sensitive-read")
        })
      }
    }

    for (const file of sensitiveFiles) {
      it(`blocks sed on ${file} (sed is mutating/unknown or sensitive-read)`, () => {
        const cmd = `sed -n 'p' ${file}`
        const res = classifyShellCommand(cmd)
        expect(res.category !== "read").toBe(true)
      })
    }
  })

  // ── C. Compound cd path classification with effective cwd ─────────────────
  describe("C: Compound cd path classification", () => {
    it("allows cd to approved repo followed by read-only git status", () => {
      const res = classifyShellCommand("cd /repo && git status", { workingDir: "/repo" })
      expect(res.category).toBe("read")
    })

    it("allows cd followed by git remote -v", () => {
      const res = classifyShellCommand("cd /repo && git remote -v", { workingDir: "/repo" })
      expect(res.category).toBe("read")
    })

    it("blocks cd into sensitive directory followed by inspection", () => {
      const res = classifyShellCommand("cd ~/.ssh && cat id_rsa")
      expect(res.category).toBe("sensitive-read")
    })

    it("blocks cd into sensitive directory with cut utility", () => {
      const res = classifyShellCommand("cd ~/.ssh && cut -d: -f1 id_rsa")
      expect(res.category).toBe("sensitive-read")
    })

    it("blocks compound command containing any mutating segment", () => {
      const res = classifyShellCommand("cd /repo && git status && rm file.txt")
      expect(res.category).toBe("mutating")
    })
  })

  // ── D. Native-read -> FDX Execution Router ─────────────────────────────────
  describe("D: FDX execution routing", () => {
    const testFile = join(tmpdir(), "fdx-test-file-" + Date.now() + ".ts")

    beforeEach(() => {
      writeFileSync(testFile, "export const meaning = 42;\nexport function answer() { return meaning; }\n")
    })

    afterEach(() => {
      try { unlinkSync(testFile) } catch {}
      delete process.env.FLOWDECK_ENFORCE_FDX_REDIRECT
      delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
    })

    it("routes native read to FDX read when enforcement is enabled", async () => {
      process.env.FLOWDECK_ENFORCE_FDX_REDIRECT = "true"
      delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT

      const route = await executeFdxRedirect("read", { file: testFile, mode: "auto" }, { directory: process.cwd() })
      if (!checkFdxAvailability()) {
        expect(route).toBeNull()
      } else {
        expect(route).not.toBeNull()
        expect(route?.targetTool).toBe("fdx-read")
        expect(route?.executed).toBe(true)
        expect(route?.output).toBeDefined()
      }
    })

    it("returns null when FDX redirect is disabled", async () => {
      process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
      const route = await executeFdxRedirect("read", { file: testFile })
      expect(route).toBeNull()
    })
  })

  // ── E. Safe temporary rm -rf parser ────────────────────────────────────────
  describe("E: Structured temporary rm -rf parser", () => {
    it("allows recursive deletion strictly inside /tmp", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/my-test-fixture-123")).toBe(true)
      expect(isSafeTemporaryRm("rm -r /tmp/test-fixture")).toBe(true)
    })

    it("allows deletion with $TMPDIR prefix", () => {
      expect(isSafeTemporaryRm("rm -rf $TMPDIR/my-test-fixture")).toBe(true)
    })

    it("blocks deletion of system or project roots", () => {
      expect(isSafeTemporaryRm("rm -rf /")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /etc")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /home")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf src/")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf package.json")).toBe(false)
    })

    it("blocks traversal out of temporary directories", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/../etc/passwd")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/../../home")).toBe(false)
    })

    it("blocks mixed safe and unsafe targets", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/safe-dir /etc/unsafe")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/safe-dir src/main.ts")).toBe(false)
    })

    it("blocks deletion of the temp root directory itself", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/")).toBe(false)
    })

    it("blocks ambiguous target names like /tmpfoo", () => {
      expect(isSafeTemporaryRm("rm -rf /tmpfoo")).toBe(false)
    })

    it("allows quoted paths containing spaces strictly inside temporary directories", () => {
      expect(isSafeTemporaryRm('rm -rf "/tmp/fixture with spaces"')).toBe(true)
      expect(isSafeTemporaryRm("rm -rf '/tmp/fixture with spaces'")).toBe(true)
    })

    it("allows multiple safe temporary targets", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/dir1 /tmp/dir2 /tmp/dir3")).toBe(true)
    })

    it("blocks traversal with $TMPDIR/../outside", () => {
      expect(isSafeTemporaryRm("rm -rf $TMPDIR/../outside")).toBe(false)
    })

    it("blocks malformed $TMPDIR expressions", () => {
      expect(isSafeTemporaryRm("rm -rf $TMPDIRfoo")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf ${TMPDIR}/something")).toBe(false)
    })

    it("blocks command substitution and subshell execution", () => {
      expect(isSafeTemporaryRm("rm -rf $TMPDIR/$(whoami)")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/`whoami`")).toBe(false)
    })

    it("blocks command chaining after safe rm", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/safe; rm -rf /")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/safe && rm -rf src/")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/safe || rm -rf /etc")).toBe(false)
    })

    it("blocks glob expansions in targets", () => {
      expect(isSafeTemporaryRm("rm -rf /tmp/*")).toBe(false)
      expect(isSafeTemporaryRm("rm -rf /tmp/?")).toBe(false)
    })
  })
})
