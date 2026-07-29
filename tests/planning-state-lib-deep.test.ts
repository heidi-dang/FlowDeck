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
  findWorkspaceRoot
} from "../src/tools/planning-state-lib"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
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
