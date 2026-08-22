import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  sessionEventsHook,
  resolveSessionLogPath,
  getCandidateLogPaths,
  _resetSessionEventsState,
} from "../src/hooks/session-events"
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function safeCleanupDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}

describe("sessionEventsHook — Comprehensive verification", () => {
  let tempDir: string

  beforeEach(() => {
    _resetSessionEventsState()
    tempDir = mkdtempSync(join(tmpdir(), "session-events-test-"))
  })

  afterEach(() => {
    _resetSessionEventsState()
    safeCleanupDir(tempDir)
  })

  it("Required 1 — directory='/' does not throw, does not create /.opencode, and logs to writable fallback", async () => {
    expect(existsSync("/.opencode")).toBe(false)
    let error: unknown = null
    try {
      await sessionEventsHook({ directory: "/" }, "error", "session-root-test")
    } catch (err) {
      error = err
    }
    expect(error).toBeNull()
    expect(existsSync("/.opencode")).toBe(false)

    // Writable fallback should be chosen and written to
    const resolved = resolveSessionLogPath("/")
    expect(resolved).not.toBeNull()
    expect(resolved).not.toContain(join("/", ".opencode"))
    expect(existsSync(resolved!)).toBe(true)

    const content = readFileSync(resolved!, "utf-8")
    expect(content).toContain('"event":"error"')
    expect(content).toContain('"detail":"Session encountered an error."')
  })

  it("Required 2 — normal writable project writes to <project>/.opencode/flowdeck.log", async () => {
    await sessionEventsHook({ directory: tempDir }, "error", "sess-proj-test")
    const expectedPath = join(tempDir, ".opencode", "flowdeck.log")
    expect(existsSync(expectedPath)).toBe(true)

    const content = readFileSync(expectedPath, "utf-8")
    expect(content).toContain('"event":"error"')
  })

  it("Required 3 — project exists but .opencode directory cannot be written to -> falls back safely", async () => {
    // Cross-platform unwritable setup: create .opencode as a plain file so mkdirSync(.opencode, { recursive: true }) fails
    const blockedProjDir = join(tempDir, "blocked-proj")
    mkdirSync(blockedProjDir, { recursive: true })
    writeFileSync(join(blockedProjDir, ".opencode"), "blocking-file-not-a-directory", "utf-8")

    let error: unknown = null
    try {
      await sessionEventsHook({ directory: blockedProjDir }, "idle", "sess-ro-test")
    } catch (err) {
      error = err
    }
    expect(error).toBeNull()

    const resolved = resolveSessionLogPath(blockedProjDir)
    expect(resolved).not.toBeNull()
    // Must have fallen back to user-state or temp, not the blocked project .opencode path
    expect(resolved).not.toContain(join(blockedProjDir, ".opencode", "flowdeck.log"))
    expect(existsSync(resolved!)).toBe(true)
  })

  it("Required 4 — all log destinations fail -> hook completes cleanly without throwing and logs at most one warning", async () => {
    const originalEnv = { ...process.env }
    const warnLogs: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnLogs.push(args.join(" "))
    }

    try {
      const uncreatableDir = "/proc/sys/fs/fake-nonexistent-unwritable/dir"
      _resetSessionEventsState()

      await sessionEventsHook({ directory: uncreatableDir }, "idle", "sess-fail-test")
      await sessionEventsHook({ directory: uncreatableDir }, "error", "sess-fail-test")

      expect(warnLogs.length).toBeLessThanOrEqual(1)
    } finally {
      console.warn = originalWarn
      process.env = originalEnv
    }
  })

  it("Required 5 — append failure after path resolution falls back and remains non-fatal", async () => {
    // First resolution succeeds on tempDir
    const resolved = resolveSessionLogPath(tempDir)
    expect(resolved).toBe(join(tempDir, ".opencode", "flowdeck.log"))

    // Make the resolved file unwritable by creating it as a directory to trigger appendFileSync EISDIR failure
    expect(resolved).not.toBeNull()
    rmSync(resolved!, { force: true })
    mkdirSync(resolved!, { recursive: true })

    let err: unknown = null
    try {
      await sessionEventsHook({ directory: tempDir }, "error", "sess-append-fail")
    } catch (e) {
      err = e
    }
    expect(err).toBeNull()
  })

  it("Required 6 — idle event detail message", async () => {
    await sessionEventsHook({ directory: tempDir }, "idle", "sess-idle-test")
    const logPath = join(tempDir, ".opencode", "flowdeck.log")
    const content = readFileSync(logPath, "utf-8")
    const entry = JSON.parse(content.trim().split("\n").pop()!)
    expect(entry.event).toBe("idle")
    expect(entry.detail).toBe("Session is idle. State checkpointed — resume with /fd-resume.")
  })

  it("Required 7 — error event detail message", async () => {
    await sessionEventsHook({ directory: tempDir }, "error", "sess-err-test")
    const logPath = join(tempDir, ".opencode", "flowdeck.log")
    const content = readFileSync(logPath, "utf-8")
    const entry = JSON.parse(content.trim().split("\n").pop()!)
    expect(entry.event).toBe("error")
    expect(entry.detail).toBe("Session encountered an error.")
  })

  it("Required 8 — completed event detail message must be 'Session completed.' and not contain error", async () => {
    await sessionEventsHook({ directory: tempDir }, "completed", "sess-comp-test")
    const logPath = join(tempDir, ".opencode", "flowdeck.log")
    const content = readFileSync(logPath, "utf-8")
    const entry = JSON.parse(content.trim().split("\n").pop()!)
    expect(entry.event).toBe("completed")
    expect(entry.detail).toBe("Session completed.")
    expect(entry.detail).not.toContain("error")
  })

  it("Required 9 — repeated events with directory='/' are cached and do not flood", async () => {
    const warnLogs: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnLogs.push(args.join(" "))
    }

    try {
      for (let i = 0; i < 10; i++) {
        await sessionEventsHook({ directory: "/" }, "error", "sess-" + i)
      }
      expect(warnLogs.length).toBeLessThanOrEqual(1)
      expect(existsSync("/.opencode")).toBe(false)
    } finally {
      console.warn = originalWarn
    }
  })

  it("Required 10 — handles paths with spaces and Unicode", async () => {
    const unicodeDir = join(tempDir, "project with spaces and 🚀 測試")
    mkdirSync(unicodeDir, { recursive: true })

    await sessionEventsHook({ directory: unicodeDir }, "completed", "sess-unicode")
    const logPath = join(unicodeDir, ".opencode", "flowdeck.log")
    expect(existsSync(logPath)).toBe(true)

    const content = readFileSync(logPath, "utf-8")
    const entry = JSON.parse(content.trim().split("\n").pop()!)
    expect(entry.event).toBe("completed")
    expect(entry.detail).toBe("Session completed.")
  })

  it("Required 11 — candidate log paths support cross-platform resolution (Windows & POSIX)", () => {
    const candidates = getCandidateLogPaths(join("some", "nested", "path"))
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(candidates[0]).toBe(join("some", "nested", "path", ".opencode", "flowdeck.log"))
    expect(candidates[candidates.length - 1]).toBe(join(tmpdir(), "flowdeck", "flowdeck.log"))

    // Filesystem root candidates must exclude project-local
    const rootCandidates = getCandidateLogPaths("/")
    expect(rootCandidates.some(c => c.includes(join("/", ".opencode")))).toBe(false)
  })

  it("Preserves JSONL format with timestamp, event, phase, and detail", async () => {
    await sessionEventsHook({ directory: tempDir }, "completed", "sess-format")
    const logPath = join(tempDir, ".opencode", "flowdeck.log")
    const content = readFileSync(logPath, "utf-8")
    const entry = JSON.parse(content.trim().split("\n").pop()!)
    expect(entry).toHaveProperty("timestamp")
    expect(entry).toHaveProperty("event", "completed")
    expect(entry).toHaveProperty("phase")
    expect(entry).toHaveProperty("detail", "Session completed.")
  })
})
