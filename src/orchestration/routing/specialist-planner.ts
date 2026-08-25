import { createHash } from "node:crypto"
import {
  getCanonicalAgent,
  getSubagentIds,
  type CanonicalAgentEntry,
} from "../../services/canonical-registry"
import {
  executionModeForClass,
  type ExecutionMode,
  type RouterDecision,
  type SpecialistDomain,
} from "../../services/heidi-fast-router"
import type { RepoMasterAdvice } from "../repository/repo-master"

export const SPECIALIST_PLAN_VERSION = "1.0.0"
export const DEFAULT_MAX_SPECIALISTS = 3

export type SpecialistPriority = "low" | "normal" | "high"

/**
 * A compact, persisted-safe projection of one native subagent assignment.
 * It intentionally excludes hidden reasoning, credentials, and model IDs.
 */
export interface SpecialistSpec {
  specialistId: string
  capability: SpecialistDomain
  role: string
  targetAgent: string
  objective: string
  scope: string[]
  expectedEvidence: string[]
  /** Canonical native subagent tools, copied from the registry and never caller-supplied. */
  allowedTools?: string[]
  dependsOn: string[]
  required: boolean
  priority: SpecialistPriority
  parentRunId: string
  modelPolicy: "inherit"
}

export interface SpecialistPlan {
  version: string
  runId: string
  executionMode: ExecutionMode
  reasonCode: string
  specs: SpecialistSpec[]
  deduplicated: number
  fanoutBlocked: number
  rejectedReason?: string
}

export interface SpecialistPlanningPolicy {
  /** Configurable policy cap; callers may supply a lower or higher product policy value. */
  maxSpecialists?: number
  /** Heidi-to-specialist is the only supported dispatch depth unless policy explicitly changes. */
  allowRecursiveDelegation?: boolean
}

export interface SpecialistCandidate {
  /** Optional deterministic plan-local ID; dependencies may refer to this value. */
  id?: string
  capability: SpecialistDomain
  targetAgent: string
  objective?: string
  scope?: string[]
  dependsOn?: string[]
  required?: boolean
  priority?: SpecialistPriority
}

export interface SpecialistPlannerInput {
  runId: string
  goal: string
  decision: RouterDecision
  candidates?: SpecialistCandidate[]
  policy?: SpecialistPlanningPolicy
  callerDepth?: number
  /** Bounded repository evidence from Repo Master; it never supplies agents, models, or execution authority. */
  repositoryAdvice?: Pick<RepoMasterAdvice, "scope" | "relevantFiles" | "architecturalConstraints" | "requestId">
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24)
}

function compactGoal(goal: string): string {
  const normalized = goal.replace(/\s+/g, " ").trim()
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`
}

function asCanonicalSubagent(targetAgent: string): CanonicalAgentEntry {
  const agent = getCanonicalAgent(targetAgent)
  if (!agent || agent.mode !== "subagent") throw new Error("SPECIALIST_TARGET_AGENT_INVALID")
  if (agent.modelPolicy !== "inherit") throw new Error("SPECIALIST_MODEL_POLICY_INVALID")
  if (agent.delegationPolicy !== "none" || agent.maxDelegationDepth !== 0) {
    throw new Error("SPECIALIST_RECURSIVE_DELEGATION_DENIED")
  }
  return agent
}

function validateDependencyGraph(specs: readonly SpecialistSpec[]): void {
  const byId = new Map(specs.map(spec => [spec.specialistId, spec]))
  if (byId.size !== specs.length) throw new Error("SPECIALIST_DUPLICATE_ID")
  for (const spec of specs) {
    const seen = new Set<string>()
    for (const dependency of spec.dependsOn) {
      if (dependency === spec.specialistId) throw new Error("SPECIALIST_SELF_DEPENDENCY")
      if (seen.has(dependency)) throw new Error("SPECIALIST_DUPLICATE_DEPENDENCY")
      if (!byId.has(dependency)) throw new Error("SPECIALIST_UNKNOWN_DEPENDENCY")
      seen.add(dependency)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("SPECIALIST_DEPENDENCY_CYCLE")
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const spec of specs) visit(spec.specialistId)
}

function candidatesFromDecision(decision: RouterDecision, goal: string, repositoryAdvice?: SpecialistPlannerInput["repositoryAdvice"]): SpecialistCandidate[] {
  const domains = decision.specialists ?? []
  const agents = decision.suggestedAgents ?? []
  return domains.flatMap((capability, index) => {
    const targetAgent = agents[index]
    if (!targetAgent) return []
    const id = `${capability.toLowerCase()}-${targetAgent}`
    const architectureId = "architecture-architect"
    const repositoryScope = repositoryAdvice?.scope.slice(0, 4) ?? []
    const constraint = repositoryAdvice?.architecturalConstraints.slice(0, 1).join(" ")
    return [{
      id,
      capability,
      targetAgent,
      objective: `Provide focused ${capability.toLowerCase()} evidence for: ${compactGoal(goal)}${constraint ? ` Constraint: ${constraint}` : ""}`,
      scope: [capability.toLowerCase(), ...repositoryScope],
      dependsOn: decision.reasonCode === "MULTI_DEEP_MIGRATION" && capability === "REVIEW" ? [architectureId] : [],
      required: true,
      priority: "normal",
    }]
  })
}

function planMode(decision: RouterDecision): ExecutionMode {
  return decision.executionMode ?? executionModeForClass(decision.executionClass)
}

/**
 * Produces the smallest useful static plan from an already-authoritative route.
 * Native execution is deliberately not performed here.
 */
export function buildSpecialistPlan(input: SpecialistPlannerInput): SpecialistPlan {
  const executionMode = planMode(input.decision)
  const policy = input.policy ?? {}
  const maxSpecialists = policy.maxSpecialists ?? DEFAULT_MAX_SPECIALISTS
  if (!Number.isInteger(maxSpecialists) || maxSpecialists < 1) throw new Error("SPECIALIST_FANOUT_POLICY_INVALID")
  if ((input.callerDepth ?? 0) > 0 || policy.allowRecursiveDelegation === true) {
    throw new Error("SPECIALIST_RECURSIVE_DELEGATION_DENIED")
  }
  if (!input.runId.trim()) throw new Error("SPECIALIST_PARENT_RUN_REQUIRED")
  if (!input.goal.trim()) throw new Error("SPECIALIST_OBJECTIVE_EMPTY")

  if (executionMode === "DIRECT") {
    return {
      version: SPECIALIST_PLAN_VERSION,
      runId: input.runId,
      executionMode,
      reasonCode: input.decision.reasonCode,
      specs: [],
      deduplicated: 0,
      fanoutBlocked: 0,
    }
  }

  const rawCandidates = input.candidates ?? candidatesFromDecision(input.decision, input.goal, input.repositoryAdvice)
  const unique = new Map<string, SpecialistCandidate>()
  let deduplicated = 0
  for (const candidate of rawCandidates) {
    const scope = [...new Set((candidate.scope ?? [candidate.capability.toLowerCase()]).map(value => value.trim().toLowerCase()).filter(Boolean))].sort()
    const identity = `${candidate.targetAgent}:${candidate.capability}:${scope.join(",")}`
    if (unique.has(identity)) {
      deduplicated += 1
      continue
    }
    unique.set(identity, { ...candidate, scope })
  }

  const selected = [...unique.values()].sort((a, b) => `${a.targetAgent}:${a.capability}`.localeCompare(`${b.targetAgent}:${b.capability}`))
  const allowed = selected.slice(0, maxSpecialists)
  const fanoutBlocked = selected.length - allowed.length
  const specs = allowed.map((candidate, index) => {
    const agent = asCanonicalSubagent(candidate.targetAgent)
    const objective = (candidate.objective ?? `Provide focused ${candidate.capability.toLowerCase()} evidence for: ${compactGoal(input.goal)}`).trim()
    if (!objective) throw new Error("SPECIALIST_OBJECTIVE_EMPTY")
    return {
      specialistId: candidate.id?.trim() || `spec-${stableId(`${input.runId}:${candidate.targetAgent}:${candidate.capability}:${candidate.scope?.join("|")}:${index}`)}`,
      capability: candidate.capability,
      role: `${candidate.capability.toLowerCase()}-specialist`,
      targetAgent: candidate.targetAgent,
      objective,
      scope: candidate.scope ?? [candidate.capability.toLowerCase()],
      expectedEvidence: ["objective_result", "scope_evidence"],
      allowedTools: [...agent.allowedTools].sort(),
      dependsOn: [...new Set(candidate.dependsOn ?? [])].sort(),
      required: candidate.required !== false,
      priority: candidate.priority ?? "normal",
      parentRunId: input.runId,
      modelPolicy: "inherit" as const,
    }
  })

  if (executionMode === "SINGLE_SPECIALIST" && specs.length !== 1) {
    return {
      version: SPECIALIST_PLAN_VERSION,
      runId: input.runId,
      executionMode,
      reasonCode: input.decision.reasonCode,
      specs: [],
      deduplicated,
      fanoutBlocked,
      rejectedReason: "SPECIALIST_CAPABILITY_UNRESOLVED",
    }
  }
  if (executionMode === "MULTI_SPECIALIST" && specs.length < 2) {
    return {
      version: SPECIALIST_PLAN_VERSION,
      runId: input.runId,
      executionMode,
      reasonCode: input.decision.reasonCode,
      specs: [],
      deduplicated,
      fanoutBlocked,
      rejectedReason: "MULTI_SPECIALIST_CAPABILITIES_UNRESOLVED",
    }
  }

  validateDependencyGraph(specs)
  return {
    version: SPECIALIST_PLAN_VERSION,
    runId: input.runId,
    executionMode,
    reasonCode: input.decision.reasonCode,
    specs,
    deduplicated,
    fanoutBlocked,
  }
}

export function readySpecialistSpecs(plan: SpecialistPlan, settledSpecialistIds: ReadonlySet<string>): SpecialistSpec[] {
  return plan.specs.filter(spec => spec.dependsOn.every(dependency => settledSpecialistIds.has(dependency)))
}

export function assertValidSpecialistPlan(plan: SpecialistPlan): void {
  if (!plan.runId.trim()) throw new Error("SPECIALIST_PARENT_RUN_REQUIRED")
  if (plan.executionMode === "DIRECT" && plan.specs.length > 0) throw new Error("DIRECT_MODE_SPECIALIST_FORBIDDEN")
  for (const spec of plan.specs) {
    if (!spec.objective.trim()) throw new Error("SPECIALIST_OBJECTIVE_EMPTY")
    if (spec.parentRunId !== plan.runId) throw new Error("SPECIALIST_CROSS_RUN_FORBIDDEN")
    if (spec.modelPolicy !== "inherit") throw new Error("SPECIALIST_MODEL_POLICY_INVALID")
    const agent = asCanonicalSubagent(spec.targetAgent)
    if (spec.allowedTools && JSON.stringify([...spec.allowedTools].sort()) !== JSON.stringify([...agent.allowedTools].sort())) {
      throw new Error("SPECIALIST_ALLOWED_TOOLS_INVALID")
    }
  }
  validateDependencyGraph(plan.specs)
}

export function parseSpecialistPlan(value: string): SpecialistPlan | null {
  try {
    const parsed = JSON.parse(value) as SpecialistPlan
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.specs)) return null
    assertValidSpecialistPlan(parsed)
    return parsed
  } catch {
    return null
  }
}

export function registeredSpecialistTargets(): string[] {
  return getSubagentIds().sort()
}
