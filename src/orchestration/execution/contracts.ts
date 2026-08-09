import { z } from "zod"

export const EXECUTION_WORKSTREAM_STATUSES = ["planned", "blocked", "ready", "running", "succeeded", "failed", "cancelled", "integration_pending", "integrated", "superseded"] as const
export type ExecutionWorkstreamStatus = typeof EXECUTION_WORKSTREAM_STATUSES[number]
export const EXECUTION_PLAN_STATUSES = ["planned", "running", "succeeded", "failed", "cancelled", "superseded"] as const
export type ExecutionPlanStatus = typeof EXECUTION_PLAN_STATUSES[number]
export const EXECUTION_LEASE_STATES = ["requested", "allocated", "active", "renewing", "completed", "reclaimable", "released", "failed"] as const
export type ExecutionLeaseState = typeof EXECUTION_LEASE_STATES[number]

const id = z.string().min(1).max(200)
const path = z.string().min(1).max(500)
const sha = z.string().regex(/^[0-9a-f]{40}$/)

export const executionWorkstreamSchema = z.object({
  workstreamId: id, runId: id, planId: id, resolvedAgent: id, requiredCapability: id,
  objective: z.string().min(1).max(5000), requirements: z.array(z.string().min(1)).max(100),
  acceptanceCriteria: z.array(z.string().min(1)).max(100), ownedPaths: z.array(path).max(200),
  ownedSymbols: z.array(id).max(200), dependsOn: z.array(id).max(100), strategy: id,
  budgetProfile: z.enum(["small", "normal", "audit", "deep-audit"]), contextScope: z.enum(["owned", "related", "audit"]),
  status: z.enum(EXECUTION_WORKSTREAM_STATUSES), worktreeRef: id.optional(), branchRef: id.optional(),
  blockedBy: z.array(id).default([]), failureReason: z.string().max(1000).optional(), createdAt: z.string().datetime(),
}).strict()
export type ExecutionWorkstream = z.infer<typeof executionWorkstreamSchema>

export const executionPlanSchema = z.object({
  planId: id, runId: id, routingDecisionId: id, sourceSha: sha, policyVersion: id,
  workstreams: z.array(executionWorkstreamSchema).min(1), createdAt: z.string().datetime(), status: z.enum(EXECUTION_PLAN_STATUSES).optional(), startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
}).strict()
export type ExecutionPlan = z.infer<typeof executionPlanSchema>

export interface ExecutionWave { index: number; workstreamIds: string[] }
export interface DependencyDiagnostics { waves: ExecutionWave[]; ready: string[]; blocked: string[]; criticalPath: string[] }

const transitions: Record<ExecutionWorkstreamStatus, readonly ExecutionWorkstreamStatus[]> = {
  planned: ["blocked", "ready", "cancelled", "superseded"], blocked: ["ready", "cancelled", "superseded"], ready: ["running", "cancelled", "superseded"],
  running: ["succeeded", "failed", "cancelled", "integration_pending"], succeeded: ["integration_pending", "superseded"], failed: ["superseded"], cancelled: ["superseded"],
  integration_pending: ["integrated", "failed", "cancelled"], integrated: ["superseded"], superseded: [],
}
const planTransitions: Record<ExecutionPlanStatus, readonly ExecutionPlanStatus[]> = {
  planned: ["running", "cancelled", "superseded"], running: ["succeeded", "failed", "cancelled", "superseded"], succeeded: ["superseded"], failed: ["superseded"], cancelled: ["superseded"], superseded: [],
}
export function assertPlanTransition(from: ExecutionPlanStatus, to: ExecutionPlanStatus): void {
  if (!planTransitions[from].includes(to)) throw new Error(`INVALID_EXECUTION_PLAN_TRANSITION:${from}->${to}`)
}
export function assertWorkstreamTransition(from: ExecutionWorkstreamStatus, to: ExecutionWorkstreamStatus): void {
  if (!transitions[from].includes(to)) throw new Error(`INVALID_WORKSTREAM_TRANSITION:${from}->${to}`)
}

export function normalizeOwnership(paths: readonly string[]): string[] {
  const normalized = paths.map(p => p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, ""))
  if (normalized.some(p => p.startsWith("../") || p === ".." || p.startsWith("/"))) throw new Error("OWNERSHIP_PATH_ESCAPE")
  return [...new Set(normalized)].sort()
}

export function ownershipClaimMatchesPath(path: string, claim: string, descendants = false): boolean {
  const candidate = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "")
  const normalizedClaim = claim.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "")
  if (normalizedClaim.endsWith("/**")) {
    const prefix = normalizedClaim.slice(0, -3).replace(/\/$/, "")
    return candidate.startsWith(`${prefix}/`)
  }
  if (normalizedClaim.endsWith("/*")) {
    const prefix = normalizedClaim.slice(0, -2).replace(/\/$/, "")
    return candidate.startsWith(`${prefix}/`) && !candidate.slice(prefix.length + 1).includes("/")
  }
  return candidate === normalizedClaim || descendants && candidate.startsWith(`${normalizedClaim}/`)
}

export function ownershipOverlaps(a: readonly string[], b: readonly string[]): boolean {
  return normalizeOwnership(a).some(left => normalizeOwnership(b).some(right => ownershipClaimMatchesPath(left, right, true) || ownershipClaimMatchesPath(right, left, true)))
}

export function analyzeDependencies(plan: ExecutionPlan): DependencyDiagnostics {
  executionPlanSchema.parse(plan)
  const byId = new Map(plan.workstreams.map(w => [w.workstreamId, w]))
  if (byId.size !== plan.workstreams.length) throw new Error("DUPLICATE_WORKSTREAM_ID")
  for (const w of plan.workstreams) {
    const seen = new Set<string>()
    for (const dep of w.dependsOn) {
      if (dep === w.workstreamId) throw new Error("SELF_DEPENDENCY")
      if (seen.has(dep)) throw new Error("DUPLICATE_DEPENDENCY")
      seen.add(dep)
      if (!byId.has(dep)) throw new Error(`UNKNOWN_DEPENDENCY:${dep}`)
    }
  }
  for (let i = 0; i < plan.workstreams.length; i++) for (let j = i + 1; j < plan.workstreams.length; j++) {
    if (ownershipOverlaps(plan.workstreams[i].ownedPaths, plan.workstreams[j].ownedPaths)) throw new Error("OVERLAPPING_OWNERSHIP")
  }
  const visiting = new Set<string>(); const visited = new Set<string>()
  const depth = new Map<string, number>(); const visit = (id: string): number => {
    if (visiting.has(id)) throw new Error("DEPENDENCY_CYCLE")
    if (visited.has(id)) return depth.get(id) ?? 0
    visiting.add(id); const w = byId.get(id)!; const d = w.dependsOn.length ? Math.max(...w.dependsOn.map(visit)) + 1 : 0
    visiting.delete(id); visited.add(id); depth.set(id, d); return d
  }
  for (const w of plan.workstreams) visit(w.workstreamId)
  const waves = [...new Set(depth.values())].sort((a, b) => a - b).map(index => ({ index, workstreamIds: plan.workstreams.filter(w => depth.get(w.workstreamId) === index).map(w => w.workstreamId).sort() }))
  const failed = new Set(plan.workstreams.filter(w => w.status === "failed").map(w => w.workstreamId))
  const blocked = plan.workstreams.filter(w => w.dependsOn.some(d => failed.has(d))).map(w => w.workstreamId).sort()
  const ready = plan.workstreams.filter(w => (w.status === "planned" || w.status === "ready") && !w.dependsOn.some(d => failed.has(d))).map(w => w.workstreamId).sort()
  const criticalPath = [...plan.workstreams].sort((a, b) => (depth.get(b.workstreamId)! - depth.get(a.workstreamId)!) || a.workstreamId.localeCompare(b.workstreamId)).map(w => w.workstreamId)
  return { waves, ready, blocked, criticalPath }
}
