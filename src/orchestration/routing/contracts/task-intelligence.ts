import { createHash } from "node:crypto"
import { z } from "zod"

export const CLASSIFIER_VERSION = "2.0.0"
export const ROUTING_POLICY_VERSION = "2.0.0"

export const TASK_CLASSES = [
  "small_bug", "large_bug", "feature", "refactor", "architecture", "investigation",
  "security", "performance", "testing", "documentation", "migration", "release",
  "ci_infrastructure", "dependency", "code_review", "audit", "multi_component", "unknown",
] as const
export type TaskClass = typeof TASK_CLASSES[number]

export const PARALLELISM_LEVELS = ["none", "limited", "high"] as const
export type ParallelismLevel = typeof PARALLELISM_LEVELS[number]
export const STRATEGIES = [
  "direct", "investigate_then_direct", "plan_then_execute", "debug_root_cause",
  "parallel_implementation", "security_review", "performance_investigation",
  "audit_only", "change_then_independent_review",
] as const
export type ExecutionStrategy = typeof STRATEGIES[number]
export const BUDGET_PROFILES = ["small", "normal", "audit", "deep-audit"] as const
export type BudgetProfile = typeof BUDGET_PROFILES[number]

export const evidenceSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), signal: z.string().min(1),
  value: z.string().min(1), weight: z.number().finite().min(0).max(100),
}).strict()
export type RoutingEvidence = z.infer<typeof evidenceSchema>

const scoreSchema = z.object({ score: z.number().int().min(0).max(100), evidence: z.array(evidenceSchema).min(1) }).strict()
export const taskAssessmentSchema = z.object({
  assessmentId: z.string().min(1), runId: z.string().min(1), taskClass: z.enum(TASK_CLASSES),
  complexity: scoreSchema, ambiguity: scoreSchema, risk: scoreSchema,
  parallelism: z.enum(PARALLELISM_LEVELS), evidence: z.array(evidenceSchema).min(1),
  classifierVersion: z.string().min(1), policyVersion: z.string().min(1), createdAt: z.string().datetime(),
}).strict()
export type TaskAssessment = z.infer<typeof taskAssessmentSchema>

export interface Workstream { id: string; ownership: string[]; dependsOn: string[]; rationale: string }
export const workstreamSchema = z.object({ id: z.string().min(1), ownership: z.array(z.string().min(1)).min(1), dependsOn: z.array(z.string()), rationale: z.string().min(1) }).strict()
export interface DelegationRecommendation { agentId: string; capability: string; ownership: string[]; rationale: string }
export const delegationSchema = z.object({ agentId: z.string().min(1), capability: z.string().min(1), ownership: z.array(z.string().min(1)).min(1), rationale: z.string().min(1) }).strict()

export const ROUTING_MODES = ["recommendation", "ownership_resolved", "enforceable"] as const
export type RoutingAuthorityMode = typeof ROUTING_MODES[number]

export const routingDecisionSchema = z.object({
  routingDecisionId: z.string().min(1), runId: z.string().min(1), decisionVersion: z.number().int().positive(), sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  routingMode: z.enum(ROUTING_MODES).optional(),
  assessment: taskAssessmentSchema, strategy: z.enum(STRATEGIES), delegate: z.boolean(),
  delegations: z.array(delegationSchema), workstreams: z.array(workstreamSchema),
  budgetRecommendation: z.enum(BUDGET_PROFILES), modelRecommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)).min(1), rejectedAlternatives: z.array(z.string()),
  policyVersion: z.string().min(1), createdAt: z.string().datetime(), finalized: z.literal(true),
}).strict()
export type RoutingDecision = z.infer<typeof routingDecisionSchema>

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).sort().join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`
  return JSON.stringify(value)
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalize(value)).digest("hex") }
export function assertUniqueEvidence(evidence: readonly RoutingEvidence[]): void {
  const ids = evidence.map(e => e.id)
  if (new Set(ids).size !== ids.length) throw new Error("ROUTING_DUPLICATE_EVIDENCE")
}
