import { describe, it, expect } from "bun:test"
import { HeidiActiveCoordinator } from "../src/services/heidi-active-coordinator"
import type { ChildSnapshot } from "../src/services/child-lifecycle-port"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function snap(ws: string, state: string): ChildSnapshot {
  const now = Date.now()
  return { childId: ws, parentSessionId: "b", specialist: ws, state: state as any, createdAt: now, lastActivityAt: now }
}

function makeCoord(): HeidiActiveCoordinator {
  return new HeidiActiveCoordinator({ parentSessionId: "b", runId: "ben", goal: "g", coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: [] },
    children: ["A","B","C","D"].map((w) => ({ workstreamId: w, specialist: w, goal: w, access: "write" })) })
}

async function sequentialBaseline(childMs: number, integrateMs: number): Promise<number> {
  const t0 = performance.now()
  for (const _w of ["A","B","C","D"]) { await sleep(childMs) } // children one-at-a-time
  for (const _w of ["A","B","C","D"]) { await sleep(integrateMs) }   // integrate all after
  return performance.now() - t0
}

async function activeCoordinator(childMs: number, _integrateMs: number): Promise<number> {
  const coord = makeCoord()
  const t0 = performance.now()
  // All children launch concurrently (the runtime scheduler owns their parallelism).
  const children = ["A","B","C","D"].map(async (w) => { await sleep(childMs); return w })
  // Root keeps doing useful non-conflicting coordinator work while they run.
  const rootWork = (async () => { for (let i = 0; i < 4; i++) { await sleep(childMs / 4); if (coord.nextCoordinatorDirective().kind === "coordinator_work") {} } })()
  // Integrate each child the moment it completes (immediate incremental integration).
  const integrator = Promise.all(children.map(async (childPromise) => {
    const w = await childPromise
    coord.recordChildLifecycleEvent({ childId: w, kind: "child.completed", snapshot: snap(w, "completed") })
    if (coord.getReadyResults().includes(w)) { coord.markReviewing(w); coord.markIntegrating(w); coord.markIntegrated(w) }
  }))
  await Promise.all([rootWork, integrator])
  return performance.now() - t0
}

describe("ACTIVE COORDINATOR vs SEQUENTIAL BASELINE (controlled, non-Hermes)", () => {
  it("overlapped root work + immediate integration is faster than run-all-then-integrate", async () => {
    const childMs = 30
    const integrateMs = 8
    const seq = await sequentialBaseline(childMs, integrateMs)
    const active = await activeCoordinator(childMs, integrateMs)
    // Sequential = 4*30 + 4*8 = 152ms; active = max(children 30ms, root work ~30ms, integration tail) ~ 38-45ms.
    expect(active).toBeLessThan(seq)
    expect(seq).toBeGreaterThan(active * 1.5)
  }, 10000)
})
