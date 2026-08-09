import type { Workstream } from "./contracts/task-intelligence"

export function validateWorkstreams(workstreams: readonly Workstream[]): void {
  const ids = new Set<string>()
  const owned = new Set<string>()
  for (const stream of workstreams) {
    if (ids.has(stream.id)) throw new Error("ROUTING_DUPLICATE_WORKSTREAM")
    ids.add(stream.id)
    for (const path of stream.ownership) {
      if ([...owned].some(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) throw new Error("ROUTING_OVERLAPPING_OWNERSHIP")
      owned.add(path)
    }
    for (const dependency of stream.dependsOn) if (!workstreams.some(candidate => candidate.id === dependency)) throw new Error("ROUTING_UNKNOWN_DEPENDENCY")
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const byId = new Map(workstreams.map(w => [w.id, w]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("ROUTING_DEPENDENCY_CYCLE")
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const stream of workstreams) visit(stream.id)
}
