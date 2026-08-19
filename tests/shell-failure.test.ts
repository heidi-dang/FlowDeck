import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeShellCommand, resetBashSpawnCount } from "../src/services/shell-executor"
import {
  normalizeShellFailure,
  describeShellFailure,
  describeShellFailureTitle,
  shellSemanticFingerprint,
  normalizeEffectiveCommand,
  ShellFailureTracker,
  type ShellFailureInfo,
} from "../src/services/shell-failure"
import { containsSecrets } from "../src/lib/secret-redaction"

const FAIL_CMD = "node -e \"console.error('intentional flowdeck regression failure'); process.exit(17)\""

function info(overrides: Partial<ShellFailureInfo> = {}): ShellFailureInfo {
  return {
    status: "failed",
    exitCode: 17,
    stderr: "intentional flowdeck regression failure\n",
    command: FAIL_CMD,
    sessionID: "root-session",
    toolName: "shell",
    repoGeneration: "repo-gen-1",
    at: Date.now(),
    ...overrides,
  }
}

describe("shell failure pipeline (deterministic)", () => {
  let tmp: string
  it("1. non-zero root Shell becomes failed", () => {
    tmp = mkdtempSync(join(tmpdir(), "fdpipeline-"))
    resetBashSpawnCount()
    const r = executeShellCommand(FAIL_CMD, { cwd: tmp })
    expect(r.status).toBe("failed")
    expect(r.bashSpawned).toBe(true)
  })
  it("2. exact exit code preserved", () => {
    const r = executeShellCommand(FAIL_CMD, { cwd: tmp })
    expect(r.exitCode).toBe(17)
  })
  it("3. stderr safely preserved / redacted", () => {
    const r = executeShellCommand(FAIL_CMD, { cwd: tmp })
    expect(r.status).toBe("failed")
    expect(r.stderr).toContain("intentional flowdeck regression failure")
    expect(containsSecrets(r.stderr)).toBe(false)
  })
  it("4. successful shell stays ok and triggers no failure", () => {
    const r = executeShellCommand("echo hello", { cwd: tmp })
    expect(r.status).toBe("ok")
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain("hello")
  })
  it("5. whole pipeline: execution -> normalize -> tracker decision", () => {
    const r = executeShellCommand(FAIL_CMD, { cwd: tmp })
    const nf = normalizeShellFailure(r, {
      command: FAIL_CMD,
      sessionID: "root-session",
      callID: "call-1",
      toolName: "shell",
      repoGeneration: "repo-gen-1",
    })
    expect(nf.status).toBe("failed")
    expect(nf.exitCode).toBe(17)
    expect(nf.stderr).toContain("intentional flowdeck regression failure")
    const tracker = new ShellFailureTracker()
    const d1 = tracker.record(nf)
    expect(d1.incidentCreated).toBe(true)
    expect(d1.strategyShouldChange).toBe(true)
    const d2 = tracker.record(nf)
    expect(d2.incidentCreated).toBe(false)
    expect(d2.isRepeat).toBe(true)
    expect(d2.repeatCount).toBe(2)
    expect(tracker.incidentCount()).toBe(1)
    expect(nf.stderr).not.toContain("api_key=")
  })
  it("6. describeShellFailure is bounded operational facts, no hidden CoT, exit code visible", () => {
    const text = describeShellFailure(info())
    expect(text).toContain("exit code 17")
    expect(text).toContain("Do not repeat the same command unchanged")
    expect(text).toContain("choose a valid alternative")
    expect(text).toContain("intentional flowdeck regression failure")
  })
  it("7. describeShellFailureTitle renders Failed · exit N", () => {
    const t = describeShellFailureTitle(info({ toolName: "shell", command: "cargo --coverage" }))
    expect(t).toContain("shell cargo --coverage")
    expect(t).toContain("Failed")
    expect(t).toContain("exit 17")
  })
  it("8. fingerprint: identical failure => identical; distinct command/repo/exit => differs", () => {
    const base = { toolName: "shell", command: "cargo --coverage", repoGeneration: "g1", exitCode: 1, stderr: "error: unexpected argument" }
    expect(shellSemanticFingerprint(base)).toBe(shellSemanticFingerprint(base))
    expect(shellSemanticFingerprint({ ...base, command: "cargo build" })).not.toBe(shellSemanticFingerprint(base))
    expect(shellSemanticFingerprint({ ...base, repoGeneration: "g2" })).not.toBe(shellSemanticFingerprint(base))
    expect(shellSemanticFingerprint({ ...base, exitCode: 2 })).not.toBe(shellSemanticFingerprint(base))
  })
  it("9. normalizeEffectiveCommand is stable and safe", () => {
    expect(normalizeEffectiveCommand("  cargo   --coverage  ")).toBe("cargo --coverage")
    expect(normalizeEffectiveCommand("echo 'a b'")).not.toContain("'")
  })
  it("10. secrets in stderr are redacted end-to-end", () => {
    const nf = normalizeShellFailure(
      { status: "failed", exitCode: 1, stderr: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234 failed", output: "" },
      { command: "curl -H", sessionID: "s", toolName: "shell", repoGeneration: "g" },
    )
    expect(containsSecrets(nf.stderr)).toBe(false)
    expect(nf.stderr).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz1234")
    expect(nf.stderr).toContain("[REDACTED")
  })
  it("11. tracker: distinct failed commands are distinct strategy attempts", () => {
    const tr = new ShellFailureTracker()
    tr.record(info({ command: "cargo --coverage", exitCode: 1 }))
    tr.record(info({ command: "cargo build", exitCode: 101 }))
    expect(tr.strategyAttemptsFor("root-session")).toBe(2)
    expect(tr.incidentCount()).toBe(2)
  })
  it("12. tracker scoped per session: sibling session untouched", () => {
    const tr = new ShellFailureTracker()
    tr.record(info({ sessionID: "child-A", command: "x" }))
    expect(tr.strategyAttemptsFor("child-B")).toBe(0)
    expect(tr.incidentCount()).toBe(1)
  })
})

describe("tool-failure propagation contract", () => {
  it("healthy session: no incident, no recovery flood (0 auto-continues)", () => {
    const tr = new ShellFailureTracker()
    expect(tr.incidentCount()).toBe(0)
    expect(tr.strategyAttemptsFor("healthy")).toBe(0)
  })
  it("no hidden CoT anywhere in failure surface", () => {
    const t = describeShellFailure(info()) + "|" + describeShellFailureTitle(info())
    expect(t).not.toContain("reasoning")
    expect(t).not.toContain("chain-of-thought")
  })
})
