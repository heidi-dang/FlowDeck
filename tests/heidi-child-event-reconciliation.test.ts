import { describe, expect, it } from "bun:test"
import { HeidiChildReconciler } from "../src/services/heidi-child-reconciler"
import { StaticChildLifecyclePort } from "../src/services/child-lifecycle-port"
import type { ChildSnapshot } from "../src/services/child-lifecycle-port"

function snap(childId: string, overrides: Partial<ChildSnapshot> = {}): ChildSnapshot {
  return {
    childId,
    parentSessionId: "parent",
    specialist: "coder",
    state: "running",
    createdAt: Date.now() - 10_000,
    lastActivityAt: Date.now() - 10_000,
    ...overrides,
  }
}

describe("HeidiChildReconciler event reconciliation", () => {
  it("event child.completed appears -> READY-style update without any poll", () => {
    const port = new StaticChildLifecyclePort("parent")
    const recon = new HeidiChildReconciler(port, "parent")

    const completed = snap("X", { state: "completed", finishedAt: Date.now() })
    recon.handleEvent({ childId: "X", kind: "child.completed", snapshot: completed })

    // State updated immediately from the event alone.
    expect(recon.getSnapshot("X")?.state).toBe("completed")
    expect(recon.getSnapshot("X")?.finishedAt).toBe(completed.finishedAt)

    // Event counters advanced; polling untouched.
    expect(recon.stats().childStatusEvents).toBe(1)
    expect(recon.stats().reconciliationPolls).toBe(0)
    expect(recon.stats().pollModelTurns).toBe(0)

    const deltas = recon.getDeltas()
    expect(deltas.get("X")?.status).toBe("completed")
  })

  it("dropped completion event: pollOnce recovers it exactly once, not on a second poll", async () => {
    const port = new StaticChildLifecyclePort("parent")
    const recon = new HeidiChildReconciler(port, "parent")

    // Persist a completed snapshot directly in the port WITHOUT delivering an event.
    const completed = snap("X", { state: "completed", finishedAt: Date.now() })
    port.upsert(completed)

    const first = await recon.pollOnce()
    expect(first.recovered).toEqual(["X"])
    expect(first.snapshotCount).toBe(1)
    expect(recon.getSnapshot("X")?.state).toBe("completed")

    // A second poll sees the same state -> nothing re-recovered, no duplicate delta.
    const second = await recon.pollOnce()
    expect(second.recovered).toEqual([])
    expect(second.changed).toEqual([])
    expect(second.newlySeen).toEqual([])
    expect(recon.stats().reconciliationPolls).toBe(2)
  })

  it("poll model turns stays 0 across many polls", async () => {
    const port = new StaticChildLifecyclePort("parent")
    const recon = new HeidiChildReconciler(port, "parent")

    for (let i = 0; i < 25; i++) {
      const report = await recon.pollOnce()
      expect(report.pollModelTurns).toBe(0)
      expect(recon.pollModelTurns()).toBe(0)
      expect(recon.stats().pollModelTurns).toBe(0)
    }
  })

  it("adaptive polling: fresh child -> small interval; long-running child -> larger interval", async () => {
    const fresh = new HeidiChildReconciler(new StaticChildLifecyclePort("parent"), "parent")
    // A freshly created running child (and a just-delivered event) -> small bump.
    fresh.handleEvent({
      childId: "A",
      kind: "child.started",
      snapshot: snap("A", { state: "running", createdAt: Date.now(), startedAt: Date.now() }),
    })
    const freshInterval = fresh.adaptiveIntervalMs()
    expect(freshInterval).toBe(5000)

    // A long-running child (started > 60s ago) -> larger interval, even with a
    // just-delivered event, because long-running precedence keeps spam down.
    const aged = new HeidiChildReconciler(new StaticChildLifecyclePort("parent"), "parent")
    aged.handleEvent({
      childId: "B",
      kind: "child.started",
      snapshot: snap("B", {
        state: "running",
        createdAt: Date.now() - 200_000,
        startedAt: Date.now() - 200_000,
        lastActivityAt: Date.now() - 200_000,
      }),
    })
    const agedInterval = aged.adaptiveIntervalMs()
    expect(agedInterval).toBe(30000)
    expect(agedInterval).toBeGreaterThan(freshInterval)

    // Steady state: running child started recently (not long-running, not
    // fresh), and lastTransitionAt sufficiently old -> healthy interval.
    const steady = new HeidiChildReconciler(new StaticChildLifecyclePort("parent"), "parent")
    steady.handleEvent({
      childId: "C",
      kind: "child.started",
      snapshot: snap("C", {
        state: "running",
        createdAt: Date.now() - 600_000,
        startedAt: Date.now() - 1_000,
        lastActivityAt: Date.now() - 1_000,
      }),
    })
    // Force lastTransitionAt into the past to reach the healthy branch.
    ;(steady as unknown as { lastTransitionAt: number }).lastTransitionAt = Date.now() - 100_000
    expect(steady.adaptiveIntervalMs()).toBe(20000)
  })

  it("never treats a watchdog/Continue prompt as an event", () => {
    const recon = new HeidiChildReconciler(new StaticChildLifecyclePort("parent"), "parent")

    // The reconciler exposes no prompt/watchdog ingestion surface.
    expect((recon as unknown as { handlePrompt?: unknown }).handlePrompt).toBeUndefined()

    // Only child lifecycle snapshots advance the event counter.
    const lifecycle = snap("W", { state: "completed" })
    recon.handleEvent({ childId: "W", kind: "child.completed", snapshot: lifecycle })
    expect(recon.stats().childStatusEvents).toBe(1)
    expect(recon.getSnapshot("W")?.state).toBe("completed")
    expect(recon.pollModelTurns()).toBe(0)
  })

  it("polling does not mutate the caller's convergence and exposes no progress counters", async () => {
    const port = new StaticChildLifecyclePort("parent")
    const recon = new HeidiChildReconciler(port, "parent")
    const asAny = recon as unknown as Record<string, unknown>

    // No progress/convergence counters surface.
    expect(asAny.progressCount).toBeUndefined()
    expect(asAny.convergenceCount).toBeUndefined()
    expect(asAny.integratedCount).toBeUndefined()

    port.upsert(snap("Y", { state: "running" }))
    for (let i = 0; i < 10; i++) {
      await recon.pollOnce()
      expect(recon.pollModelTurns()).toBe(0)
      expect(recon.stats().pollModelTurns).toBe(0)
    }
  })
})
