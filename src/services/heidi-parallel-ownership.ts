/**
 * Heidi Parallel Ownership — formal write/read scopes for parallel coordinator
 * work (Roadmap item 4).
 *
 * Extends the write-scope concepts already in HeidiParallelEngine
 * (fileScopes / access) without adding unrelated locking semantics:
 *   - disjoint child write scopes          -> allowed
 *   - overlapping child write scopes       -> blocked before children start
 *   - child vs Heidi overlap               -> blocked until explicit handoff
 *   - root may READ child-owned files      -> always safe while child runs
 */

export interface ParallelWorkstreamOwnership {
  workstreamId: string
  agent: string
  access: "read" | "write"
  ownedScopes: string[]
  forbiddenScopes: string[]
  expectedOutputs: string[]
}

export interface CoordinatorOwnership {
  integrationScopes: string[]
  readScopes: string[]
}

export interface OwnershipConflict {
  a: string
  b: string
  scope: string
}

const SEP = "/"

function normalizeScope(scope: string): string {
  return (scope ?? "").replace(/\\/g, SEP).replace(/^\/+|\/+$/g, "")
}

/** True when two paths overlap as files or directory prefixes. */
export function scopesOverlap(a: string, b: string): boolean {
  const na = normalizeScope(a)
  const nb = normalizeScope(b)
  if (!na || !nb) return false
  return na === nb || na.startsWith(nb + SEP) || nb.startsWith(na + SEP)
}

export function findOwnershipConflicts(children: ParallelWorkstreamOwnership[]): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = []
  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const ca = children[i]
      const cb = children[j]
      if (ca.access !== "write" && cb.access !== "write") continue
      const aScopes = ca.access === "write" ? ca.ownedScopes : []
      const bScopes = cb.access === "write" ? cb.ownedScopes : []
      for (const sa of aScopes) {
        for (const sb of bScopes) {
          if (scopesOverlap(sa, sb)) {
            conflicts.push({ a: ca.workstreamId, b: cb.workstreamId, scope: sa })
          }
        }
      }
    }
  }
  return conflicts
}

/** Throw when two write children would overlap. Call before dispatch. */
export function assertDisjointWrites(children: ParallelWorkstreamOwnership[]): void {
  const conflicts = findOwnershipConflicts(children)
  if (conflicts.length > 0) {
    const c = conflicts[0]
    throw new Error("WRITE_SCOPE_CONFLICT: " + c.a + " and " + c.b + " overlap on " + c.scope)
  }
}

/** The child may write a path only if it is inside its OWN write scopes. */
export function canChildWrite(ownership: ParallelWorkstreamOwnership | undefined, path: string): boolean {
  if (!ownership || ownership.access !== "write") return false
  return ownership.ownedScopes.some((s) => scopesOverlap(s, path))
}

/** Root may always read child-owned files (inspection is allowed). */
export function canRootRead(_ownership: ParallelWorkstreamOwnership | undefined, _path: string): boolean {
  return true
}

/**
 * Root may write a path if it is in the root's integration scopes AND the path
 * is not inside an ACTIVE child's write scope unless an explicit handoff granted it.
 */
export function canRootWrite(
  children: ParallelWorkstreamOwnership[],
  coordinator: CoordinatorOwnership,
  path: string,
  handoffScopes: string[] = [],
): { allowed: boolean; conflict?: string } {
  const inCoordinator = coordinator.integrationScopes.some((s) => scopesOverlap(s, path))
  if (!inCoordinator) return { allowed: false, conflict: "not_in_coordinator_scope" }
  for (const child of children) {
    if (child.access !== "write") continue
    const owned = child.ownedScopes.some((s) => scopesOverlap(s, path))
    if (owned && !handoffScopes.some((s) => scopesOverlap(s, path))) {
      return { allowed: false, conflict: "child_owns_" + child.workstreamId }
    }
  }
  return { allowed: true }
}

export { normalizeScope }

