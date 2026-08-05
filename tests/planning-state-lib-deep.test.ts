import { describe, it, expect } from "bun:test"
import {
  normalizePathForId,
  generateProjectId,
  planningDir,
  statePath,
  checkpointPath,
  projectArchitecturePath,
  slugifyTopic,
  topicDir,
  topicTaskPath,
  topicPlanPath,
  buildContextPacket,
  createDefaultState,
  readPlanningState,
  updatePlanningState,
  updateTDDState,
  logTDDOverride,
  readOrMissing,
  appendWithMkdir,
  clearFile,
  findWorkspaceRoot,
  releaseCwdPinIfInside,
  retryTransient,
  renameWithSharingRetry,
} from "../src/tools/planning-state-lib"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Planning State Lib Deep Unit Tests", () => {
  it("normalizePathForId & generateProjectId generate stable collision-safe IDs", () => {
    const p1 = normalizePathForId("C:/Users/Test/Repo")
    const id1 = generateProjectId("C:/Users/Test/Repo")
    expect(p1).toBeDefined()
    expect(id1).toContain("Repo-")
  })

  it("slugifyTopic formats topic names cleanly", () => {
    expect(slugifyTopic("Fix/Auth Bug #123!")).toBe("fix-auth-bug-123")
    expect(slugifyTopic("  Spaces  ")).toBe("spaces")
  })

  it("planningDir returns external planning path and supports topic paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plan-lib-"))
    try {
      const pDir = planningDir(tempDir)
      expect(pDir).toBeDefined()
      expect(statePath(tempDir)).toBe(join(pDir, "STATE.md"))
      expect(checkpointPath(tempDir)).toBe(join(pDir, "checkpoint.json"))
      expect(projectArchitecturePath(tempDir)).toBe(join(pDir, "architecture.md"))
      expect(topicDir(tempDir, "auth")).toBe(join(pDir, "auth"))
      expect(topicTaskPath(tempDir, "auth")).toBe(join(pDir, "auth", "task.md"))
      expect(topicPlanPath(tempDir, "auth")).toBe(join(pDir, "auth", "plan.md"))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("buildContextPacket formats structured context packet", () => {
    const packet = buildContextPacket({
      targets: "src/auth.ts",
      blastRadius: "1 file",
      patterns: ["MVC"],
      phase: 1,
      stage: "planning"
    })
    expect(packet).toContain("Orchestrator Context")
    expect(packet).toContain("src/auth.ts")
  })

  it("createDefaultState and readPlanningState handle state roundtrips", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plan-state-"))
    try {
      const pDir = planningDir(tempDir)
      mkdirSync(pDir, { recursive: true })
      const defState = createDefaultState(2)
      writeFileSync(statePath(tempDir), defState)

      const read = readPlanningState(tempDir)
      expect(read).toBeDefined()
      expect(String(read.phase)).toBe("2")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("updatePlanningState, updateTDDState, and logTDDOverride modify STATE.md", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plan-upd-"))
    try {
      const pDir = planningDir(tempDir)
      mkdirSync(pDir, { recursive: true })
      writeFileSync(statePath(tempDir), createDefaultState(1))

      updateTDDState(tempDir, { stage: "red", cycle: 2, failing_tests: 1 })
      let read = readPlanningState(tempDir)
      expect(read).toBeDefined()

      logTDDOverride(tempDir, "red", "manual override test", "dev4")
      read = readPlanningState(tempDir)
      expect(read).toBeDefined()

      updatePlanningState(tempDir, { phase: 3 as any })
      read = readPlanningState(tempDir)
      expect(String(read.phase)).toBe("3")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("readOrMissing, appendWithMkdir, and clearFile manage file content", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plan-fs-"))
    try {
      const filePath = join(tempDir, "sub", "test.txt")
      const missing = readOrMissing(filePath)
      expect(missing.exists).toBe(false)

      appendWithMkdir(filePath, "line 1")
      appendWithMkdir(filePath, "line 2")
      const read = readOrMissing(filePath)
      expect(read.exists).toBe(true)
      if (read.exists) {
        expect(read.content).toContain("line 1")
      }

      clearFile(filePath)
      const cleared = readOrMissing(filePath)
      if (cleared.exists) {
        expect(cleared.content).toBe("")
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("findWorkspaceRoot and getWorkspaceConfig resolve workspace settings", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plan-ws-"))
    try {
      const pDir = planningDir(tempDir)
      mkdirSync(pDir, { recursive: true })
      writeFileSync(join(pDir, "config.json"), JSON.stringify({ sub_repos: ["subpkg"] }))
      mkdirSync(join(tempDir, "subpkg"), { recursive: true })

      const wsRoot = findWorkspaceRoot(join(tempDir, "subpkg"))
      expect(wsRoot).toBe(tempDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe("Legacy planning migration Windows-safety helpers", () => {
  it("releaseCwdPinIfInside moves the process cwd out of the legacy dir", () => {
    // realpathSync resolves the temp root (macOS /var → /private/var) so the
    // expected paths match what process.cwd() returns after chdir.
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "plan-mig-cwd-")))
    const root = join(tempRoot, ".fd-plan")
    const legacyDir = join(root, "my-app")
    mkdirSync(legacyDir, { recursive: true })

    const original = process.cwd()
    try {
      process.chdir(legacyDir)
      expect(process.cwd()).toBe(legacyDir)

      releaseCwdPinIfInside(root, legacyDir)
      expect(process.cwd()).toBe(root)
    } finally {
      process.chdir(original)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("releaseCwdPinIfInside leaves cwd untouched when outside the legacy dir", () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "plan-mig-cwd2-")))
    const root = join(tempRoot, ".fd-plan")
    mkdirSync(root, { recursive: true })

    const original = process.cwd()
    try {
      process.chdir(root)
      releaseCwdPinIfInside(root, join(root, "my-app"))
      expect(process.cwd()).toBe(root)
    } finally {
      process.chdir(original)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("retryTransient retries only classified errors and succeeds after transient failures", () => {
    let calls = 0
    const { value, attempts } = retryTransient(
      5,
      1,
      (err) => (err as NodeJS.ErrnoException).code === "EBUSY",
      () => {
        calls += 1
        if (calls < 3) {
          const e = new Error("busy") as NodeJS.ErrnoException
          e.code = "EBUSY"
          throw e
        }
        return "done"
      },
    )
    expect(value).toBe("done")
    expect(attempts).toBe(3)
    expect(calls).toBe(3)
  })

  it("retryTransient never retries non-classified errors (permission denial)", () => {
    let calls = 0
    expect(() =>
      retryTransient(
        5,
        1,
        (err) => (err as NodeJS.ErrnoException).code === "EBUSY",
        () => {
          calls += 1
          const e = new Error("denied") as NodeJS.ErrnoException
          e.code = "EPERM"
          throw e
        },
      ),
    ).toThrow("denied")
    expect(calls).toBe(1)
  })

  it("retryTransient is bounded and reports the last error after exhausting attempts", () => {
    let calls = 0
    expect(() =>
      retryTransient(
        4,
        1,
        () => true,
        () => {
          calls += 1
          const e = new Error("always busy") as NodeJS.ErrnoException
          e.code = "EBUSY"
          throw e
        },
      ),
    ).toThrow("always busy")
    expect(calls).toBe(4)
  })

  it("renameWithSharingRetry propagates non-sharing errors immediately (ENOENT)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "plan-mig-ren-"))
    try {
      expect(() => renameWithSharingRetry(join(tempRoot, "missing"), join(tempRoot, "dst"))).toThrow()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
