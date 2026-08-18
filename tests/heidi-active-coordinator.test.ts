import { describe, it, expect } from "bun:test"
import { HeidiActiveCoordinator } from "../src/services/heidi-active-coordinator"
import type { ChildSnapshot } from "../src/services/child-lifecycle-port"

function child(workstreamId: string, state: string): ChildSnapshot {
  const now = Date.now()
  return { childId: workstreamId, parentSessionId: "s1", specialist: workstreamId, state: state as any, createdAt: now, lastActivityAt: now }
}

function make(input?: Record<string, unknown>): HeidiActiveCoordinator {
  const args: Record<string, unknown> = {
    parentSessionId: "s1",
    runId: "run1",
    goal: "repo audit",
    coordinatorOwnership: { integrationScopes: ["src/index.ts", "tests/"], readScopes: ["src/"] },
    children: [
      { workstreamId: "A", specialist: "security-auditor", goal: "audit fdx", access: "write", fileScopes: ["src/services/fdx/"] },
      { workstreamId: "B", specialist: "reviewer", goal: "review audit", access: "write", fileScopes: ["src/services/audit/"] },
      { workstreamId: "C", specialist: "architect", goal: "arch", access: "write", fileScopes: ["src/services/ok/"] },
      { workstreamId: "D", specialist: "tester", goal: "test", access: "write", fileScopes: ["src/services/score/"] },
    ],
  }
  if (input) Object.assign(args, input)
  return new HeidiActiveCoordinator(args as any)
}

describe("FANOUT RECONCILIATION", () => {
  it("desired 4 / observed 1 -> missing B C D; duplicate A = 0", () => {
    const c = make()
    c.markLaunched("A")
    const r = c.reconcileChildren([child("A", "running")])
    expect(r.missing.sort()).toEqual(["B", "C", "D"])
    expect(r.launchDirectives.map(d => d.workstreamId).sort()).toEqual(["B", "C", "D"])
    expect(r.launchDirectives.filter(d => d.workstreamId === "A")).toHaveLength(0)
    expect(r.duplicates).toHaveLength(0)
  })

  it("all four materialize -> missing 0, no duplicate directives", () => {
    const c = make()
    c.markLaunched("A"); c.markLaunched("B"); c.markLaunched("C"); c.markLaunched("D")
    const r = c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    expect(r.missing).toHaveLength(0)
    expect(r.launchDirectives).toHaveLength(0)
  })

  it("never relaunches an already-launched workstream within the window", () => {
    const c = make({ relaunchWindowMs: 60_000 })
    c.markLaunched("B")
    const r1 = c.reconcileChildren([child("A", "running")])
    expect(r1.launchDirectives.map(d => d.workstreamId)).not.toContain("B")
  })
})

describe("ROOT REMAINS ACTIVE", () => {
  it("all children running + coordinator work available -> next directive != wait", () => {
    const c = make()
    c.markLaunched("A"); c.markLaunched("B"); c.markLaunched("C"); c.markLaunched("D")
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    const d = c.nextCoordinatorDirective()
    expect(d.kind).toBe("coordinator_work")
    expect(c.getPhase()).toBe("coordinator_active")
  })

  it("root does not duplicate a running child owned scope", () => {
    const c = make()
    c.reconcileChildren([child("A", "running")])
    const blocked = c.canRootWrite("src/services/fdx/x.ts")
    expect(blocked.allowed).toBe(false)
  })
})

describe("IMMEDIATE INCREMENTAL INTEGRATION", () => {
  it("B ready while A/C/D running -> next directive = integrate B (not wait)", () => {
    const c = make()
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    c.recordChildLifecycleEvent({ childId: "B", kind: "child.completed", snapshot: { ...child("B", "completed"), specialist: "reviewer" } })
    const ready = c.getReadyResults()
    expect(ready).toContain("B")
    const d = c.nextCoordinatorDirective()
    expect(d.kind).toBe("integrate_ready")
    expect(d.nodeId).toBe("B")
  })

  it("review -> integrating -> focused verification -> integrated; A/C/D keep running", () => {
    const c = make()
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    c.recordChildLifecycleEvent({ childId: "B", kind: "child.completed", snapshot: { ...child("B", "completed"), specialist: "reviewer" } })
    c.markReviewing("B")
    c.markIntegrating("B")
    c.markVerified("B")
    c.markIntegrated("B")
    expect(c.getReadyResults()).not.toContain("B")
    expect(c.shouldEnterFinalConvergence()).toBe(false)
  })
})

describe("MULTIPLE READY + OVERLAP", () => {
  it("B and D ready near-simultaneously -> deterministic queue (completion time then id)", () => {
    const c = make()
    c.recordChildLifecycleEvent({ childId: "D", kind: "child.completed", snapshot: { ...child("D", "completed"), specialist: "tester", finishedAt: Date.now() - 5, createdAt: Date.now() - 5 } })
    c.recordChildLifecycleEvent({ childId: "B", kind: "child.completed", snapshot: { ...child("B", "completed"), specialist: "reviewer", finishedAt: Date.now() - 2, createdAt: Date.now() - 2 } })
    const ready = c.getReadyResults()
    expect(ready).toHaveLength(2)
    expect(ready[0]).toBe("D")
    expect(ready[1]).toBe("B")
  })

  it("first integration before last child completes (no await-all barrier)", () => {
    const c = make()
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    c.recordChildLifecycleEvent({ childId: "B", kind: "child.completed", snapshot: { ...child("B", "completed"), specialist: "reviewer" } })
    c.markIntegrating("B")
    expect(c.shouldWaitForAll()).toBe(false)
    expect(c.canRootWrite("src/index.ts").allowed).toBe(true)
  })
})

describe("CONTRACT + CONVERGENCE", () => {
  it("stable contract allows integration prep but not child-owned writes", () => {
    const c = make()
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    c.markContractStable("C", { exports: ["executeFastRewrite"], ownFiles: ["src/services/tool-fast-lane.ts"] })
    expect(c.canRootWrite("src/index.ts").allowed).toBe(true)
    expect(c.canRootWrite("src/services/tool-fast-lane.ts").allowed).toBe(false)
  })

  it("contract changed after stable invalidates prepared integration", () => {
    const c = make()
    c.markContractStable("C", { exports: ["oldExport"] })
    c.markContractChangedAfterStable("C")
    const d = c.describe()
    expect(d.children.find((x) => x.workstreamId === "C")?.integration).toBe("pending")
  })

  it("final convergence only after all required children are integrated", () => {
    const c = make()
    for (const w of ["A","B","C","D"]) {
      c.recordChildLifecycleEvent({ childId: w, kind: "child.completed", snapshot: { ...child(w, "completed"), specialist: w } })
      c.markIntegrating(w)
      c.markIntegrated(w)
    }
    expect(c.shouldEnterFinalConvergence()).toBe(true)
    c.enterFinalConvergence()
    expect(c.shouldWaitForAll()).toBe(true)
    expect(c.getPhase()).toBe("final_convergence")
    expect(c.workDuplicationEvents()).toBe(0)
  })

  it("reconcile polling is not a model turn and never counts as progress", () => {
    const c = make()
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    c.reconcileChildren(["A","B","C","D"].map((w) => child(w, "running")))
    expect(c.pollModelTurns()).toBe(0)
  })
})
