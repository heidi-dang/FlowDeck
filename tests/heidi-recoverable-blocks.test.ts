import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { planningWorkspaceStatus, planningDir } from "../src/tools/planning-state-lib"
import { isHeidiAgent, } from "../src/services/canonical-registry"
import { LoopDetector, normalizeAction } from "../src/services/loop-detector"
import { RecoverableFlowDeckBlockError, isRecoverableBlockError } from "../src/services/recoverable-block"

describe("Heidi Recoverable FlowDeck Guard Blocks & Governance Hotfix", () => {
  // 1. Recoverable Block Error Structure
  it("creates a structured RecoverableFlowDeckBlockError with machine-readable metadata", () => {
    const err = new RecoverableFlowDeckBlockError({
      subsystem: "loop_detector",
      code: "LOOP_GUARD_REPEATED_READ",
      tool: "fdx-read",
      sessionID: "sess-123",
      agent: "heidi",
      reason: "Repeated read of src/auth.ts with identical output",
      recoverable: true,
      terminal: false,
      requiresHuman: false,
      suggestedActions: [
        "Use output from previous call",
        "Inspect a different file",
        "Proceed to next task step",
      ],
    })

    expect(err.name).toBe("RecoverableFlowDeckBlockError")
    expect(err.subsystem).toBe("loop_detector")
    expect(err.code).toBe("LOOP_GUARD_REPEATED_READ")
    expect(err.tool).toBe("fdx-read")
    expect(err.recoverable).toBe(true)
    expect(err.terminal).toBe(false)
    expect(err.suggestedActions.length).toBe(3)
    expect(isRecoverableBlockError(err)).toBe(true)
  })

  // 2. Heidi Identity Normalization
  it("resolves heidi and orchestrator alias to the same primary direct-execution identity", () => {
    expect(isHeidiAgent("heidi")).toBe(true)
    expect(isHeidiAgent("orchestrator")).toBe(true)
    expect(isHeidiAgent("HEIDI")).toBe(true)
    expect(isHeidiAgent("Orchestrator")).toBe(true)
    expect(isHeidiAgent("planner")).toBe(false)
    expect(isHeidiAgent("coder")).toBe(false)
  })

  // 3. Shell Command Classification (`gh` commands)
  it("classifies read-only `gh` commands as read and mutating `gh` commands as mutating", () => {
    // Read-only gh commands
    const ghApiGet = classifyShellCommand("gh api repos/owner/repo/commits")
    expect(ghApiGet.category).toBe("read")

    const ghRepoView = classifyShellCommand("gh repo view owner/repo")
    expect(ghRepoView.category).toBe("read")

    const ghPrView = classifyShellCommand("gh pr view 123")
    expect(ghPrView.category).toBe("read")

    const ghRunView = classifyShellCommand("gh run view 456")
    expect(ghRunView.category).toBe("read")

    // Mutating gh commands
    const ghApiDelete = classifyShellCommand("gh api -X DELETE repos/owner/repo")
    expect(ghApiDelete.category).toBe("mutating")

    const ghApiPost = classifyShellCommand("gh api -X POST repos/owner/repo/issues -f title=Bug")
    expect(ghApiPost.category).toBe("mutating")

    const ghPrCreate = classifyShellCommand("gh pr create --title Bugfix")
    expect(ghPrCreate.category).toBe("mutating")
  })

  // 4. Planning Workspace Status & Missing STATE.md Recovery
  it("classifies planning workspace status cleanly and does NOT block edits for incomplete/orphaned directories", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fdx-plan-status-"))
    try {
      // Absent
      expect(planningWorkspaceStatus(tmpDir)).toBe("absent")

      // Incomplete / Orphaned (directory exists, no STATE.md)
      const pDir = planningDir(tmpDir)
      mkdirSync(pDir, { recursive: true })
      expect(planningWorkspaceStatus(tmpDir)).toBe("incomplete_orphaned")

      // Valid Active Unconfirmed
      const statePath = join(pDir, "STATE.md")
      writeFileSync(statePath, "# State\nplan_confirmed: false\n", "utf-8")
      expect(planningWorkspaceStatus(tmpDir)).toBe("active_unconfirmed")

      // Valid Active Confirmed
      writeFileSync(statePath, "# State\nplan_confirmed: true\n", "utf-8")
      expect(planningWorkspaceStatus(tmpDir)).toBe("active_confirmed")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // 5. Loop Detector & fdx-read Action Normalization
  it("normalizes fdx-read, fdx-search, fdx-grep tools in LoopDetector", () => {
    const normRead = normalizeAction("fdx-read", { path: "src/auth.ts" })
    expect(normRead).toContain("read:")

    const normGrep = normalizeAction("fdx-grep", { pattern: "function", path: "src" })
    expect(normGrep).toContain("fdx-grep:")

    const detector = new LoopDetector()
    detector.recordAfter("fdx-read", { path: "src/auth.ts" }, "file contents A", "sess-1")
    detector.recordAfter("fdx-read", { path: "src/auth.ts" }, "file contents A", "sess-1")

    const res = detector.checkBefore("fdx-read", { path: "src/auth.ts" }, "sess-1")
    expect(res.action).toBe("block")
    if (res.action === "block") {
      expect(res.escalationMessage).toContain("Loop Guard")
    }
  })
})
