import { describe, it, expect } from "bun:test"
import {
  HeidiActiveCoordinator,
  registerParallelCoordinator,
  clearParallelCoordinator,
} from "../src/services/heidi-active-coordinator"
import {
  renderParallelPacket,
  estimateParallelPacketTokens,
} from "../src/services/heidi-parallel-context"
import type { ChildSnapshot } from "../src/services/child-lifecycle-port"

describe("heidi parallel live surface", () => {
  it("renders a compact packet and reflects READY integration at the next boundary", () => {
    const now = Date.now()
    const coord = new HeidiActiveCoordinator({
      parentSessionId: "s-live",
      runId: "r1",
      goal: "parallel live surface test",
      coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: ["src/**"] },
      children: [
        { workstreamId: "ws-a", specialist: "backend-coder", goal: "a", access: "write", fileScopes: ["src/a"] },
        { workstreamId: "ws-b", specialist: "frontend-coder", goal: "b", access: "write", fileScopes: ["src/b"] },
        { workstreamId: "ws-c", specialist: "devops", goal: "c", access: "write", fileScopes: ["src/c"] },
      ],
    })
    registerParallelCoordinator("s-live", coord)

    try {
      // Before any child completes, packet must be non-empty and under 200 tokens.
      const pre = renderParallelPacket("s-live")
      expect(pre.length).toBeGreaterThan(0)
      expect(estimateParallelPacketTokens("s-live")).toBeLessThan(200)

      // Launch the three children (reconcile so they are observed/running).
      const snapshot = (id: string, state: string, finishedAt?: number): ChildSnapshot => ({
        childId: id,
        parentSessionId: "s-live",
        specialist: "backend-coder",
        state: state as ChildSnapshot["state"],
        createdAt: now,
        startedAt: now,
        finishedAt,
        lastActivityAt: now,
      })
      coord.recordChildLifecycleEvent({ childId: "ws-a", kind: "child.started", snapshot: snapshot("ws-a", "running") })
      coord.recordChildLifecycleEvent({ childId: "ws-b", kind: "child.started", snapshot: snapshot("ws-b", "running") })
      coord.recordChildLifecycleEvent({ childId: "ws-c", kind: "child.started", snapshot: snapshot("ws-c", "running") })
      coord.markLaunched("ws-a")
      coord.markLaunched("ws-b")
      coord.markLaunched("ws-c")

      // A child completes -> packet must show READY and Next: integrate_ready.
      coord.recordChildLifecycleEvent({ childId: "ws-a", kind: "child.completed", snapshot: snapshot("ws-a", "completed", now + 1) })

      const post = renderParallelPacket("s-live")
      expect(post).toContain("Ready: 1")
      expect(post).toContain("Next: integrate_ready")
      expect(estimateParallelPacketTokens("s-live")).toBeLessThan(200)

      // Never leak hidden reasoning, transcripts, or chain-of-thought prompts.
      expect(post).not.toContain("Continue")
      expect(post).not.toContain("Check your subagents")
      expect(post).not.toContain("chain-of-thought")
      expect(post).not.toContain("transcript")
      expect(post).not.toContain("reasoning")
    } finally {
      clearParallelCoordinator("s-live")
    }
  })

  it("returns empty string when no coordinator is registered", () => {
    expect(renderParallelPacket("s-none")).toBe("")
    expect(estimateParallelPacketTokens("s-none")).toBe(0)
  })
})
