/**
 * Routing contract: agent capability and delegation records.
 *
 * Describes what specialists can do (capabilities), the shape of results
 * they return, and the nodes of a routed work graph.
 */

import { z } from "zod"
import { zNonEmptyId } from "./task"
import { getAllAgentIds, getPrimaryAgentIds } from "@/services/canonical-registry"

/**
 * Canonical agent identities derived from the canonical agent registry
 * (single source of truth). The routing contract never duplicates the
 * authoritative agent list; additions/removals propagate here automatically.
 */
export const CANONICAL_AGENT_IDS: readonly string[] = Object.freeze(getAllAgentIds())

/**
 * Canonical delegating agents: only primary orchestrator agents (heidi /
 * orchestrator, `delegationPolicy: "justified_only"`) may delegate.
 * Specialists (`delegationPolicy: "none"`) can never be a delegating agent.
 */
export const CANONICAL_DELEGATING_AGENT_IDS: readonly string[] = Object.freeze(getPrimaryAgentIds())

/** Returns true when `agentId` is a canonical agent (target must exist). */
export function isCanonicalAgent(agentId: string): boolean {
  return CANONICAL_AGENT_IDS.includes(agentId)
}

/** Returns true when `agentId` is a canonical delegating (orchestrator) agent. */
export function isCanonicalDelegatingAgent(agentId: string): boolean {
  return CANONICAL_DELEGATING_AGENT_IDS.includes(agentId)
}

/**
 * Canonical capability identifier. A capability id names a concrete
 * capability from the canonical capability set (document section 7.2) that
 * a strategy or model floor may require.
 */
export type Capability = string

/** Expected latency class of a capability's tools. */
export type LatencyClass = "instant" | "fast" | "slow"

/** Statuses that end a specialist result; no further work is expected. */
export const SPECIALIST_TERMINAL_STATUSES = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const

/** Terminal status of a specialist result. */
export type SpecialistStatus = (typeof SPECIALIST_TERMINAL_STATUSES)[number]

/** Declares a capability a specialist agent may provide. */
export interface CapabilityDescriptor {
  capability: Capability
  allowedAgents: string[]
  tools: string[]
  mutating: boolean
  requiresHuman: boolean
  supportsParallelism: boolean
  supportsCancellation: boolean
  expectedLatencyClass: LatencyClass
}

/** A single finding surfaced by a specialist. */
export interface FindingRef {
  id: string
  summary: string
  severity: "info" | "warning" | "critical"
  location?: string
}

/** A file-level change claimed by a specialist result. */
export interface ChangeRef {
  file: string
  kind: "create" | "modify" | "delete"
  symbol?: string
}

/** A piece of evidence backing a specialist result. */
export interface EvidenceRef {
  id: string
  kind: "log" | "test" | "diff" | "observation" | "metric"
  detail: string
}

/** Result returned by a specialist after executing an assigned node. */
export interface SpecialistResult {
  status: SpecialistStatus
  summary: string
  findings: FindingRef[]
  changes: ChangeRef[]
  evidence: EvidenceRef[]
  assumptions: string[]
  unresolvedRisks: string[]
  confidence: number
  recommendedNextAction: string
  ownershipUsed: string[]
  tokens?: { input: number; output: number }
  durationMs?: number
}

/**
 * Returns true when `r` satisfies its assignment: a completed result must
 * carry a non-empty summary and at least one piece of evidence; any other
 * terminal status must carry either evidence or a non-empty summary (the
 * reason for the failure, block, or cancellation).
 */
export function specialistResultHasRequiredEvidence(r: SpecialistResult): boolean {
  if (r.status === "completed") {
    return r.summary.length > 0 && r.evidence.length > 0
  }
  return r.summary.length > 0 || r.evidence.length > 0
}

/**
 * Why the router delegated a node. Only valid when `allowed` is true; the
 * allowed and rejected vocabularies are split so a decision cannot carry
 * both (document section 8.2).
 */
export type DelegationReason =
  | "explicit_user_request"
  | "independent_ownership"
  | "specialist_expertise"
  | "independent_audit"
  | "direct_discovery_failed"
  | "multi_domain"

/** Why the router refused to delegate a node (document section 8.3). */
export type RejectedDelegationReason =
  | "rejected_trivial"
  | "rejected_overlap"
  | "rejected_no_advantage"
  | "rejected_cost"

/**
 * The router's delegation verdict for a node (document section 8.1).
 * Cross-field invariants enforced by zDelegationDecision:
 * - `depth` is exactly 0 or 1 (max delegation depth is one).
 * - the delegating agent never targets itself (no self-delegation).
 * - an allowed decision carries `reason` and never `rejectionReason`;
 *   a rejected decision carries `rejectionReason` and never `reason`.
 */
export interface DelegationDecision {
  taskId: string
  delegatingAgent: string
  targetAgent: string
  depth: number
  allowed: boolean
  reason?: DelegationReason
  rejectionReason?: RejectedDelegationReason
  /** Persisted evidence for the decision. */
  justification: string[]
}

/** The kind of work a work node represents. */
export type WorkNodeType = "inspect" | "implement" | "verify" | "review"

/** A node in the routed work graph. */
export interface WorkNode {
  id: string
  type: WorkNodeType
  dependencies: string[]
  fileOwnership: string[]
  requiredCapabilities: string[]
  estimatedTokens: number
  estimatedDurationMs: number
  priority: number
}

/** Returns true when `value` is a valid latency class. */
export function isValidLatencyClass(value: unknown): value is LatencyClass {
  return value === "instant" || value === "fast" || value === "slow"
}

/** Zod schema for a LatencyClass value. */
export const zLatencyClass = z.enum(["instant", "fast", "slow"] as const)

/** Zod schema for a CapabilityDescriptor; capability ids must be non-empty. */
export const zCapabilityDescriptor = z.object({
  capability: zNonEmptyId,
  allowedAgents: z.array(z.string()),
  tools: z.array(z.string()),
  mutating: z.boolean(),
  requiresHuman: z.boolean(),
  supportsParallelism: z.boolean(),
  supportsCancellation: z.boolean(),
  expectedLatencyClass: zLatencyClass,
})

/** Zod schema for a FindingRef; ids must be non-empty identifiers. */
export const zFindingRef = z.object({
  id: zNonEmptyId,
  summary: z.string(),
  severity: z.enum(["info", "warning", "critical"] as const),
  location: z.string().optional(),
})

/** Zod schema for a ChangeRef. */
export const zChangeRef = z.object({
  file: z.string(),
  kind: z.enum(["create", "modify", "delete"] as const),
  symbol: z.string().optional(),
})

/** Zod schema for an EvidenceRef; ids must be non-empty identifiers. */
export const zEvidenceRef = z.object({
  id: zNonEmptyId,
  kind: z.enum(["log", "test", "diff", "observation", "metric"] as const),
  detail: z.string(),
})

/** Zod schema for a SpecialistResult with required-evidence enforcement. */
export const zSpecialistResult = z
  .object({
    status: z.enum(SPECIALIST_TERMINAL_STATUSES),
    summary: z.string(),
    findings: z.array(zFindingRef),
    changes: z.array(zChangeRef),
    evidence: z.array(zEvidenceRef),
    assumptions: z.array(z.string()),
    unresolvedRisks: z.array(z.string()),
    confidence: z.number().int().min(0).max(100),
    recommendedNextAction: z.string(),
    ownershipUsed: z.array(z.string()),
    tokens: z
      .object({
        input: z.number().int().min(0),
        output: z.number().int().min(0),
      })
      .optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .superRefine((r, ctx) => {
    if (!specialistResultHasRequiredEvidence(r)) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          "completed results require a non-empty summary and at least one evidence entry; other terminal statuses require evidence or a non-empty summary",
      })
    }
  })

/** Zod schema for an allowed DelegationReason value. */
export const zDelegationReason = z.enum(
  [
    "explicit_user_request",
    "independent_ownership",
    "specialist_expertise",
    "independent_audit",
    "direct_discovery_failed",
    "multi_domain",
  ] as const,
)

/** Zod schema for a RejectedDelegationReason value. */
export const zRejectedDelegationReason = z.enum(
  [
    "rejected_trivial",
    "rejected_overlap",
    "rejected_no_advantage",
    "rejected_cost",
  ] as const,
)

/** Rejects empty and whitespace-only justification entries. */
const zNonEmptyString = z.string().refine((s) => s.trim().length > 0, {
  message: "must not be empty or whitespace-only",
})

/** Zod schema for a DelegationDecision with cross-field invariant checks. */
export const zDelegationDecision = z
  .object({
    taskId: zNonEmptyId,
    delegatingAgent: zNonEmptyId,
    targetAgent: zNonEmptyId,
    depth: z
      .number()
      .int()
      .refine((d) => d === 0 || d === 1, { message: "depth must be exactly 0 or 1" }),
    allowed: z.boolean(),
    reason: zDelegationReason.optional(),
    rejectionReason: zRejectedDelegationReason.optional(),
    justification: z.array(zNonEmptyString),
  })
  .superRefine((d, ctx) => {
    // Only canonical orchestrator/delegating agents may delegate; a
    // specialist can never be a delegating agent.
    if (!isCanonicalDelegatingAgent(d.delegatingAgent)) {
      ctx.addIssue({
        code: "custom",
        path: ["delegatingAgent"],
        message: `only canonical delegating agents may delegate; "${d.delegatingAgent}" is not one`,
      })
    }
    // Target must exist in the canonical registry.
    if (!isCanonicalAgent(d.targetAgent)) {
      ctx.addIssue({
        code: "custom",
        path: ["targetAgent"],
        message: `target agent "${d.targetAgent}" does not exist in the canonical registry`,
      })
    }
    if (d.delegatingAgent === d.targetAgent) {
      ctx.addIssue({ code: "custom", path: ["targetAgent"], message: "self-delegation is not allowed" })
    }
    if (d.allowed) {
      if (d.reason === undefined) {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "allowed decisions require an allowed reason" })
      }
      if (d.rejectionReason !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rejectionReason"],
          message: "allowed decisions cannot carry a rejection reason",
        })
      }
      // Allowed decisions must carry non-empty justification evidence.
      if (d.justification.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["justification"],
          message: "allowed decisions require non-empty justification evidence",
        })
      }
    } else {
      if (d.rejectionReason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rejectionReason"],
          message: "rejected decisions require a rejection reason",
        })
      }
      if (d.reason !== undefined) {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "rejected decisions cannot carry an allowed reason" })
      }
      // Overlap/cost rejections must preserve justification evidence.
      if (
        (d.rejectionReason === "rejected_overlap" || d.rejectionReason === "rejected_cost") &&
        d.justification.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["justification"],
          message: "rejected overlap/cost decisions require justification evidence",
        })
      }
    }
  })

/** Zod schema for a WorkNodeType value. */
export const zWorkNodeType = z.enum(["inspect", "implement", "verify", "review"] as const)

/** Zod schema for a WorkNode. */
export const zWorkNode = z.object({
  id: z.string(),
  type: zWorkNodeType,
  dependencies: z.array(z.string()),
  fileOwnership: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  estimatedTokens: z.number().min(0),
  estimatedDurationMs: z.number().min(0),
  priority: z.number().int(),
})
