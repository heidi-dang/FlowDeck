import { describe, it, expect } from "bun:test"
import { findOwnershipConflicts, assertDisjointWrites, canRootWrite, canChildWrite, scopesOverlap } from "../src/services/heidi-parallel-ownership"

describe("HEIDI PARALLEL OWNERSHIP", () => {
  it("disjoint write children are allowed to run together", () => {
    const A = { workstreamId: "A", agent: "backend-coder", access: "write" as const, ownedScopes: ["src/services/fdx/"], forbiddenScopes: [], expectedOutputs: [] }
    const B = { workstreamId: "B", agent: "tester", access: "write" as const, ownedScopes: ["src/services/audit/"], forbiddenScopes: [], expectedOutputs: [] }
    expect(findOwnershipConflicts([A, B])).toHaveLength(0)
    expect(scopesOverlap("src/services/fdx/x.ts", "src/services/fdx/")).toBe(true)
  })

  it("overlapping child write scopes are BLOCKED before dispatch", () => {
    const A = { workstreamId: "A", agent: "a", access: "write" as const, ownedScopes: ["src/services/foo/"], forbiddenScopes: [], expectedOutputs: [] }
    const B = { workstreamId: "B", agent: "b", access: "write" as const, ownedScopes: ["src/services/foo/bar.ts"], forbiddenScopes: [], expectedOutputs: [] }
    expect(findOwnershipConflicts([A, B]).length).toBeGreaterThan(0)
    expect(() => assertDisjointWrites([A, B])).toThrow(/WRITE_SCOPE_CONFLICT/)
  })

  it("root may READ child-owned files while the child runs", () => {
    const A = { workstreamId: "A", agent: "a", access: "write" as const, ownedScopes: ["src/services/fdx-runtime.ts"], forbiddenScopes: [], expectedOutputs: [] }
    expect(scopesOverlap("src/services/fdx-runtime.ts", "src/services/fdx-runtime.ts")).toBe(true)
    expect(canChildWrite(A, "src/services/fdx-runtime.ts")).toBe(true)
  })

  it("root may NOT mutate an active child scope before handoff; handoff transfers ownership", () => {
    const A = { workstreamId: "A", agent: "a", access: "write" as const, ownedScopes: ["src/services/something.ts"], forbiddenScopes: [], expectedOutputs: [] }
    const coord = { integrationScopes: ["src"], readScopes: [] }
    const blocked = canRootWrite([A], coord, "src/services/something.ts")
    expect(blocked.allowed).toBe(false)
    expect(blocked.conflict).toBe("child_owns_A")
    const allowed = canRootWrite([A], coord, "src/services/something.ts", ["src/services/something.ts"])
    expect(allowed.allowed).toBe(true)
  })

  it("child writes only inside its own write scopes", () => {
    const A = { workstreamId: "A", agent: "a", access: "write" as const, ownedScopes: ["src/services/foo/"], forbiddenScopes: [], expectedOutputs: [] }
    expect(canChildWrite(A, "src/services/foo/x.ts")).toBe(true)
    expect(canChildWrite(A, "src/services/other/y.ts")).toBe(false)
  })
})
