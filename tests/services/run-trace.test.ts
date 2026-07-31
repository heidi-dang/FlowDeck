import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { startTrace, endTrace, listTraces } from "../../src/services/run-trace"

describe("run-trace endTrace dual signature parity", () => {
  let tempDir1: string
  let tempDir2: string

  beforeEach(() => {
    tempDir1 = mkdtempSync(join(tmpdir(), "run-trace-opt-"))
    tempDir2 = mkdtempSync(join(tmpdir(), "run-trace-pos-"))
  })

  afterEach(() => {
    try { rmSync(tempDir1, { recursive: true, force: true }) } catch {}
    try { rmSync(tempDir2, { recursive: true, force: true }) } catch {}
  })

  it("supports options object call and legacy positional call with parity", () => {
    const trace1 = startTrace(tempDir1, "build", {})
    const trace2 = startTrace(tempDir2, "build", {})

    // Call options signature
    endTrace(tempDir1, trace1.run_id, {
      status: "complete",
      outcome: "Success",
    })

    // Call legacy positional signature
    endTrace(tempDir2, trace2.run_id, "complete", "Success")

    const traces1 = listTraces(tempDir1)
    const traces2 = listTraces(tempDir2)

    expect(traces1.length).toBe(1)
    expect(traces2.length).toBe(1)

    expect(traces1[0].status).toBe("complete")
    expect(traces2[0].status).toBe("complete")

    expect(traces1[0].outcome).toBe("Success")
    expect(traces2[0].outcome).toBe("Success")

    expect(traces1[0].command).toBe(traces2[0].command)
  })

  it("handles error outcomes identically across signatures", () => {
    const trace1 = startTrace(tempDir1, "test", {})
    const trace2 = startTrace(tempDir2, "test", {})

    endTrace(tempDir1, trace1.run_id, {
      status: "failed",
      outcome: "Build Error",
      error: "Compilation failed on line 42",
    })

    endTrace(tempDir2, trace2.run_id, "failed", "Build Error", "Compilation failed on line 42")

    const t1 = listTraces(tempDir1)[0]
    const t2 = listTraces(tempDir2)[0]

    expect(t1.status).toBe("failed")
    expect(t2.status).toBe("failed")
    expect(t1.outcome).toBe("Build Error")
    expect(t2.outcome).toBe("Build Error")
    expect(t1.error).toBe("Compilation failed on line 42")
    expect(t2.error).toBe("Compilation failed on line 42")
  })
})
