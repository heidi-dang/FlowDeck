import { describe, expect, it, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeShellCommand, resetBashSpawnCount } from "../src/services/shell-executor"
import {
  normalizeShellFailure,
  describeShellFailure,
  describeShellFailureTitle,
  shellSemanticFingerprint,
  ShellFailureTracker,
  type ShellFailureInfo,
} from "../src/services/shell-failure"
import { containsSecrets } from "../src/lib/secret-redaction"

/**
 * Sanitized pathological fixture reproducing the v2.2.0 live incident shape:
 *   root audit task, 4 parallel specialists, one workstream executes an
 *   invalid command, the command exits non-zero, stderr exists (WebUI
 *   previously failed to expose the terminal error; root stayed Thinking).
 * Proves the FIXED behavior end-to-end through execution, normalization,
 * correlation, and recovery — deterministic, no live provider.
 */
const INVALID_CMD = "cargo --coverage"

describe("v2.2.0 silent-tool-failure pathological fixture (fixed)", () => {
  const root = "root-heidi"
  const children = ["par_coder", "par_researcher", "par_tester", "par_architect"]
  let tmp = ""

  it("fixture: one child workstream's invalid command exits non-zero with stderr", () => {
    tmp = mkdtempSync(join(tmpdir(), "fd-incident-"))
    resetBashSpawnCount()
    const r = executeShellCommand("node -e \"console.error('error: unexpected argument'); process.exit(1)\"", { cwd: tmp })
    expect(r.status).toBe("failed")
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it("child workstream failure is represented, correlated, and bounded", () => {
    const r = executeShellCommand("node -e \"console.error('error: unexpected argument \\\"'--coverage'\\\"' found'); process.exit(1)\"", { cwd: tmp })
    const child = children[0] // par_coder executes the invalid command
    const info: ShellFailureInfo = normalizeShellFailure(r, {
      command: INVALID_CMD,
      sessionID: child,
      callID: "tool_call_incident",
      toolName: "shell",
      repoGeneration: "4f1a2b3c",
    })
    expect(info.status).toBe("failed")
    expect(info.callID).toBe("tool_call_incident")
    expect(info.sessionID).toBe(child)

    const tracker = new ShellFailureTracker()
    const decision = tracker.record(info)
    expect(decision.incidentCreated).toBe(true)
    expect(decision.strategyShouldChange).toBe(true)

    const visible = describeShellFailure(info)
    expect(visible).toContain("exit code " + info.exitCode)
    expect(visible).toContain(INVALID_CMD)
    expect(visible).toContain("Do not repeat the same command unchanged")
    expect(visible).toContain("choose a valid alternative")

    const row = describeShellFailureTitle(info)
    expect(row).toContain("shell " + INVALID_CMD)
    expect(row).toContain("Failed")
    expect(row).toContain("exit " + info.exitCode)
    expect(containsSecrets(visible + "|" + row)).toBe(false)
    expect((visible + "|" + row).toLowerCase()).not.toContain("chain-of-thought")
  })

  it("sibling children unaffected; incident scoped to the failing child", () => {
    const tracker = new ShellFailureTracker()
    const r = executeShellCommand("node -e \"console.error('x'); process.exit(1)\"", { cwd: tmp })
    tracker.record(normalizeShellFailure(r, { command: INVALID_CMD, sessionID: children[0], toolName: "shell" }))
    expect(tracker.strategyAttemptsFor(children[1])).toBe(0)
    expect(tracker.strategyAttemptsFor(children[2])).toBe(0)
    expect(tracker.strategyAttemptsFor(children[3])).toBe(0)
    expect(tracker.incidentCount()).toBe(1)
    expect(root).toBeTruthy()
  })

  it("repeated identical invalid command creates no recovery flood", () => {
    const tracker = new ShellFailureTracker()
    const r = executeShellCommand("node -e \"console.error('error: unexpected argument'); process.exit(1)\"", { cwd: tmp })
    const info = normalizeShellFailure(r, { command: INVALID_CMD, sessionID: children[0], toolName: "shell", repoGeneration: "g" })
    tracker.record(info); tracker.record(info); tracker.record(info)
    expect(tracker.incidentCount()).toBe(1)
    expect(tracker.strategyAttemptsFor(children[0])).toBe(1)
    const ok = executeShellCommand("echo ok", { cwd: tmp })
    expect(ok.status).toBe("ok")
  })

  it("stable fingerprint; a different strategy differs semantically", () => {
    const fp = shellSemanticFingerprint({ toolName: "shell", command: INVALID_CMD, repoGeneration: "4f1a2b3c", exitCode: 1, stderr: "error: unexpected argument '--coverage' found" })
    expect(fp).toBe(shellSemanticFingerprint({ toolName: "shell", command: INVALID_CMD, repoGeneration: "4f1a2b3c", exitCode: 1, stderr: "error: unexpected argument '--coverage' found" }))
    const alt = shellSemanticFingerprint({ toolName: "shell", command: "cargo test", repoGeneration: "4f1a2b3c", exitCode: 0, stderr: "" })
    expect(alt).not.toBe(fp)
  })

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })
})
