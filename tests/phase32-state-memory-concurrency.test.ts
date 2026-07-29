import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { acquireLock, releaseLock, withLock } from "@/services/async-lock"
import {
  proposeCandidate,
  approveCandidate,
  rejectCandidate,
  loadCandidatePending,
  loadCandidateApproved,
} from "@/services/candidate-approval"

const TMP = join(tmpdir(), "phase32-concurrency-test-" + Date.now())

describe("Phase 32 — State/Memory Concurrency & Candidate Approval Path", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  it("1. two overlapping writers do not corrupt state when using lock synchronization barrier", async () => {
    const stateFile = join(TMP, "state.json")
    const lockFile = join(TMP, "state.lock")
    writeFileSync(stateFile, JSON.stringify({ count: 0, updates: [] }), "utf-8")

    // Concurrent writer 1
    const writer1 = withLock(lockFile, async () => {
      const current = JSON.parse(readFileSync(stateFile, "utf-8"))
      // Simulate async processing delay
      await new Promise((r) => setTimeout(r, 50))
      current.count += 1
      current.updates.push("writer1")
      writeFileSync(stateFile, JSON.stringify(current), "utf-8")
    })

    // Concurrent writer 2
    const writer2 = withLock(lockFile, async () => {
      const current = JSON.parse(readFileSync(stateFile, "utf-8"))
      await new Promise((r) => setTimeout(r, 30))
      current.count += 1
      current.updates.push("writer2")
      writeFileSync(stateFile, JSON.stringify(current), "utf-8")
    })

    await Promise.all([writer1, writer2])

    const finalState = JSON.parse(readFileSync(stateFile, "utf-8"))
    expect(finalState.count).toBe(2)
    expect(finalState.updates.length).toBe(2)
    expect(finalState.updates.sort()).toEqual(["writer1", "writer2"])
  })

  it("2. lock contention throws timeout error and does not silently fall through", async () => {
    const lockFile = join(TMP, "contention.lock")
    await acquireLock(lockFile, { timeout: 1000 })

    let acquiredSecondTime = false
    let contentionError: Error | null = null

    try {
      // Short timeout (100ms) to verify fast rejection
      await acquireLock(lockFile, { timeout: 100 })
      acquiredSecondTime = true
    } catch (err: any) {
      contentionError = err
    } finally {
      await releaseLock(lockFile)
    }

    expect(acquiredSecondTime).toBe(false)
    expect(contentionError).not.toBeNull()
    expect(contentionError?.message).toMatch(/Cannot acquire lock|Timed out/i)
  })

  it("3. final state remains valid and contains complete winning updates", async () => {
    const stateFile = join(TMP, "valid_state.json")
    const lockFile = join(TMP, "valid_state.lock")
    writeFileSync(stateFile, JSON.stringify({ status: "initial", payload: "base" }), "utf-8")

    const updateTask = (payload: string) =>
      withLock(lockFile, async () => {
        const cur = JSON.parse(readFileSync(stateFile, "utf-8"))
        cur.payload = payload
        writeFileSync(stateFile, JSON.stringify(cur), "utf-8")
      })

    await Promise.all([updateTask("payload_A"), updateTask("payload_B")])

    const finalState = JSON.parse(readFileSync(stateFile, "utf-8"))
    expect(["payload_A", "payload_B"]).toContain(finalState.payload)
    expect(finalState.status).toBe("initial")
  })

  it("4. specialist agent cannot approve a durable candidate mutation", async () => {
    const candId = `cand-spec-${Date.now()}`
    proposeCandidate(TMP, "backend-coder", candId, "db_schema", { table: "users" })

    // Specialist agent 'backend-coder' attempts approval
    const res = await approveCandidate(TMP, "backend-coder", candId)

    expect(res.success).toBe(false)
    expect(res.error).toContain("Specialist agent")
    expect(loadCandidateApproved(TMP, candId)).toBeNull()
    expect(loadCandidatePending(TMP, candId)).not.toBeNull()
  })

  it("5. candidate remains pending before primary approval", () => {
    const candId = `cand-pending-${Date.now()}`
    proposeCandidate(TMP, "frontend-coder", candId, "theme", "dark")

    const pending = loadCandidatePending(TMP, candId)
    const approved = loadCandidateApproved(TMP, candId)

    expect(pending).not.toBeNull()
    expect(pending?.status).toBe("pending")
    expect(approved).toBeNull()
  })

  it("6. primary-agent approval persists the candidate exactly once", async () => {
    const candId = `cand-primary-${Date.now()}`
    proposeCandidate(TMP, "architect", candId, "route", "/api/v2")

    // Primary agent 'heidi' approves
    const res = await approveCandidate(TMP, "heidi", candId)

    expect(res.success).toBe(true)
    expect(res.candidate?.status).toBe("approved")
    expect(loadCandidateApproved(TMP, candId)).not.toBeNull()
    expect(loadCandidatePending(TMP, candId)).toBeNull()
  })

  it("7. repeated approval is idempotent", async () => {
    const candId = `cand-idempotent-${Date.now()}`
    proposeCandidate(TMP, "architect", candId, "setting", "enabled")

    const res1 = await approveCandidate(TMP, "heidi", candId)
    expect(res1.success).toBe(true)

    // Repeat approval with primary agent 'orchestrator'
    const res2 = await approveCandidate(TMP, "orchestrator", candId)
    expect(res2.success).toBe(true)
    expect(res2.candidate?.status).toBe("approved")
  })

  it("8. candidate rejection performs no durable mutation", async () => {
    const candId = `cand-reject-${Date.now()}`
    proposeCandidate(TMP, "researcher", candId, "temp_flag", true)

    const res = await rejectCandidate(TMP, "heidi", candId)

    expect(res.success).toBe(true)
    expect(loadCandidateApproved(TMP, candId)).toBeNull()
    expect(loadCandidatePending(TMP, candId)).toBeNull()
  })
})
