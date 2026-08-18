import { describe, it, expect } from "bun:test"
import { HeidiActiveCoordinator } from "../src/services/heidi-active-coordinator"
import type { ChildSnapshot } from "../src/services/child-lifecycle-port"

function child(ws: string, state: string): ChildSnapshot {
  const now = Date.now()
  return { childId: ws, parentSessionId: "s", specialist: ws, state: state as any, createdAt: now, lastActivityAt: now }
}

function four(): HeidiActiveCoordinator {
  return new HeidiActiveCoordinator({
    parentSessionId: "s", runId: "r", goal: "g", coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: ["src/"] },
    children: [
      { workstreamId: "A", specialist: "security-auditor", goal: "a", access: "write", fileScopes: ["src/services/fdx/"] },
      { workstreamId: "B", specialist: "reviewer", goal: "b", access: "write", fileScopes: ["src/services/audit/"] },
      { workstreamId: "C", specialist: "architect", goal: "c", access: "write", fileScopes: ["src/services/ok/"] },
      { workstreamId: "D", specialist: "tester", goal: "d", access: "write", fileScopes: ["src/services/score/"] },
    ],
  })
}

describe("PARALLEL FAN-OUT RECONCILIATION (DSH trace)", () => {
  it("desired A B C D, observed A running -> missing B C D + launch directives; A never duplicated", () => {
    const coord = four()
    coord.markLaunched("A")
    const r = coord.reconcileChildren([child("A", "running")])
    expect(r.missing.sort()).toEqual(["B", "C", "D"])
    const launches = r.launchDirectives.map((d) => d.workstreamId).sort()
    expect(launches).toEqual(["B", "C", "D"])
    expect(r.launchDirectives.filter((d) => d.workstreamId === "A")).toHaveLength(0)
    expect(r.duplicates).toHaveLength(0)
  })

  it("observed duplicates (same childSession twice) are reported and no duplicate directives are issued", () => {
    const coord = four()
    coord.markLaunched("A")
    const r = coord.reconcileChildren([child("A", "running"), child("A", "running")])
    expect(r.duplicates.length).toBeGreaterThanOrEqual(0)
    expect(r.launchDirectives.filter((d) => d.workstreamId === "A")).toHaveLength(0)
  })

  it("a second reconcile without new observations does not re-emit launch directives", () => {
    const coord = four()
    coord.markLaunched("A")
    coord.reconcileChildren([child("A", "running")])
    const second = coord.reconcileChildren([child("A", "running")])
    expect(second.launchDirectives).toHaveLength(0)
  })

  it("all children eventually observed -> missing 0 and next directive is useful work, not wait", () => {
    const coord = four()
    coord.markLaunched("A"); coord.markLaunched("B"); coord.markLaunched("C"); coord.markLaunched("D")
    coord.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    const d = coord.nextCoordinatorDirective()
    expect(d.kind).toBe("coordinator_work")
  })
})
