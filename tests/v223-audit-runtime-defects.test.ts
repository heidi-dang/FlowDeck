/**
 * Comprehensive Regression Suite for Real Heidi v2.2.3 Full-Audit Defects
 *
 * Verifies:
 * 1. P0: Root Session Depth Invariant (Root Heidi is always depth 0; 5/5 parallel specialists start at depth 1).
 * 2. P0: Session Ancestry isolation from Message Causality (raw message parentIDs never corrupt session depth).
 * 3. P0: Elimination of Synthetic Recovery Continuation Flood on tool-bearing or in-flight turns.
 * 4. P1: fdx-grep, fdx-search, and fdx-read reject empty/missing parameters deterministically without stalling.
 * 5. P2: fdx-read resolves relative paths correctly against workspace directory.
 * 6. P1: Doctor governance.modes checks pass across off/advisory/strict.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { sessionAncestry } from "../src/services/session-ancestry"
import { validateDelegationDepth, evaluateGovernanceToolCheck } from "../src/services/governance-wiring"
import { detectNoVisibleOutputCompletion } from "../src/services/provider-history-safety"
import { fdxGrepTool, fdxSearchTool, fdxReadTool } from "../src/tools/fdx"
import { nativeReadFallback, setActiveProjectDir } from "../src/tools/fdx-shared"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"

describe("Heidi v2.2.3 Audit Runtime Defect Regressions", () => {
  beforeEach(() => {
    sessionAncestry.clear()
  })

  describe("P0: Root Session Depth & Session Provenance", () => {
    it("ensures root Heidi session is ALWAYS depth 0", () => {
      const rootSessionID = "ses_root_audit_123"
      const rootRecord = sessionAncestry.registerSession(rootSessionID, "heidi")
      expect(rootRecord.depth).toBe(0)
      expect(rootRecord.isRootCoordinator).toBe(true)
      expect(sessionAncestry.getEffectiveDepth(rootSessionID, "heidi")).toBe(0)
    })

    it("prevents message causality (msg.parentID) from corrupting root session depth", () => {
      const rootSessionID = "ses_fe6ff34e6ffen3k0J7Ci3fmTpW"
      // Initial root registration
      sessionAncestry.registerSession(rootSessionID, "heidi")

      // Subsequent message updated event with raw message parentID
      const messageParentID = "msg_01900cc48fffa1234567"
      sessionAncestry.registerSession(rootSessionID, "heidi", messageParentID)

      // Effective depth MUST remain 0
      expect(sessionAncestry.getEffectiveDepth(rootSessionID, "heidi")).toBe(0)
      const session = sessionAncestry.getSession(rootSessionID)
      expect(session?.depth).toBe(0)
      expect(session?.isRootCoordinator).toBe(true)
      expect(session?.parentSessionID).toBeUndefined()
    })

    it("allows 5/5 parallel specialists to be spawned from root session at depth 1 concurrently", () => {
      const rootSessionID = "ses_root_coordinator"
      sessionAncestry.registerSession(rootSessionID, "heidi")
      expect(sessionAncestry.getEffectiveDepth(rootSessionID, "heidi")).toBe(0)

      const specialists = [
        "debug-specialist",
        "architect",
        "security-auditor",
        "tester",
        "reviewer",
      ]

      const specialistSet = new Set(specialists)

      for (const specialist of specialists) {
        const rootDepth = sessionAncestry.getEffectiveDepth(rootSessionID, "heidi")
        expect(rootDepth).toBe(0)

        // Validation check for delegation from root Heidi (depth 0)
        const check = validateDelegationDepth("heidi", specialist, rootDepth, specialistSet, 1)
        expect(check.allowed).toBe(true)

        // Register the child session
        const childSessionID = `ses_child_${specialist}`
        const childRecord = sessionAncestry.registerSession(childSessionID, specialist, rootSessionID)
        expect(childRecord.depth).toBe(1)
        expect(childRecord.parentSessionID).toBe(rootSessionID)
        expect(sessionAncestry.getEffectiveDepth(childSessionID, specialist)).toBe(1)

        // Child specialist delegating further must be blocked
        const childDepth = sessionAncestry.getEffectiveDepth(childSessionID, specialist)
        const childDelegationCheck = validateDelegationDepth(specialist, "coder", childDepth, specialistSet, 1)
        expect(childDelegationCheck.allowed).toBe(false)
        expect(childDelegationCheck.errorCode).toBe("SPECIALIST_CANNOT_DELEGATE")
      }
    })
  })

  describe("P0: Synthetic Recovery Continuation Flood Prevention", () => {
    it("never classifies turns with finish='tool-calls' as malformed/reasoning-only", () => {
      const msg = {
        info: {
          id: "msg_turn_1",
          sessionID: "ses_1",
          role: "assistant",
          finish: "tool-calls",
        },
        parts: [],
      }

      const result = detectNoVisibleOutputCompletion(msg as any, { confirmedTerminal: true })
      expect(result.isMalformed).toBe(false)
    })

    it("never classifies turns with tool execution parts as malformed even with no text", () => {
      const msg = {
        info: {
          id: "msg_turn_2",
          sessionID: "ses_1",
          role: "assistant",
          finishReason: "stop",
        },
        parts: [
          { type: "reasoning", text: "Planning parallel delegation" },
          { type: "tool", state: "running", tool: "task" },
        ],
      }

      const result = detectNoVisibleOutputCompletion(msg as any, { confirmedTerminal: true })
      expect(result.isMalformed).toBe(false)
    })

    it("never classifies in-flight snapshots with empty parts and no finish reason as malformed", () => {
      const msg = {
        info: {
          id: "msg_turn_3",
          sessionID: "ses_1",
          role: "assistant",
        },
        parts: [],
      }

      const result = detectNoVisibleOutputCompletion(msg as any, { confirmedTerminal: false })
      expect(result.isMalformed).toBe(false)
    })
  })

  describe("P1: FDX Input Parameter Validation", () => {
    it("rejects fdx-grep with empty pattern immediately without stalling", async () => {
      expect(async () => {
        await fdxGrepTool.execute({} as any, {} as any)
      }).toThrow("pattern parameter is required and cannot be empty")

      expect(async () => {
        await fdxGrepTool.execute({ pattern: "   " } as any, {} as any)
      }).toThrow("pattern parameter is required and cannot be empty")
    })

    it("rejects fdx-search with empty query immediately without stalling", async () => {
      expect(async () => {
        await fdxSearchTool.execute({} as any, {} as any)
      }).toThrow("query parameter is required and cannot be empty")
    })

    it("rejects fdx-read with empty file immediately without stalling", async () => {
      expect(async () => {
        await fdxReadTool.execute({} as any, {} as any)
      }).toThrow("file parameter is required and cannot be empty")
    })
  })

  describe("P2: FDX Relative Path Resolution", () => {
    it("resolves relative file paths correctly in nativeReadFallback", () => {
      const tempDir = join(tmpdir(), "fdx-test-rel-" + Date.now())
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test-rel" }))

      setActiveProjectDir(tempDir)
      const res = nativeReadFallback("package.json")
      expect(res).toContain("test-rel")

      rmSync(tempDir, { recursive: true, force: true })
      setActiveProjectDir(process.cwd())
    })
  })

  describe("P1: Governance Modes Probe Verification", () => {
    it("evaluates governance tool checks deterministically across off, advisory, and strict modes", () => {
      const testDir = join(tmpdir(), "gov-test-modes-" + Date.now())
      mkdirSync(testDir, { recursive: true })
      const dirOff = join(testDir, "off")
      const dirAdv = join(testDir, "adv")
      const dirStrict = join(testDir, "strict")
      mkdirSync(dirOff); mkdirSync(join(dirOff, ".opencode"))
      mkdirSync(dirAdv); mkdirSync(join(dirAdv, ".opencode"))
      mkdirSync(dirStrict); mkdirSync(join(dirStrict, ".opencode"))

      writeFileSync(join(dirOff, ".flowdeck.json"), '{"governance":{"validator":{"mode":"off"}}}')
      writeFileSync(join(dirAdv, ".flowdeck.json"), '{"governance":{"validator":{"mode":"advisory"}}}')
      writeFileSync(join(dirStrict, ".flowdeck.json"), '{"governance":{"validator":{"mode":"strict"}}}')

      const modeOff = evaluateGovernanceToolCheck({ directory: dirOff, agent: "planner", tool: "bash" })
      const modeAdv = evaluateGovernanceToolCheck({ directory: dirAdv, agent: "planner", tool: "bash" })
      const modeStrict = evaluateGovernanceToolCheck({ directory: dirStrict, agent: "planner", tool: "bash" })

      expect(modeOff.action).toBe("allow")
      expect(modeAdv.action).toBe("warn")
      expect(modeStrict.action).toBe("block")

      rmSync(testDir, { recursive: true, force: true })
    })
  })
})
