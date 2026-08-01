/**
 * Routing contract: agent capability and delegation records.
 *
 * Describes what specialists can do (capabilities), the shape of results
 * they return, and the nodes of a routed work graph.
 */

import { z } from "zod"
import { zNonEmptyId, zMeaningfulString, isMeaningfulText } from "./task"
import { getAllAgentIds, getPrimaryAgentIds, getSubagentIds, getAllCanonicalAgents } from "@/services/canonical-registry"

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

/**
 * Canonical subagent (specialist) ids derived from the canonical registry.
 * These are the only valid delegation targets for routing decisions.
 */
export const CANONICAL_SUBAGENT_IDS: readonly string[] = Object.freeze(getSubagentIds())

/**
 * Canonical alias map: every primary agent id and every alias resolves to the
 * same canonical principal. Built at module load from the canonical registry.
 *
 * Currently `orchestrator` is an alias of `heidi` (the canonical primary).
 * Both resolve to `"heidi"`.  This map is used by `resolveCanonicalPrincipal`
 * so alias-based comparisons never produce false negatives.
 */
export const CANONICAL_ALIAS_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  // Every primary agent id maps to itself.
  for (const primary of getPrimaryAgentIds()) {
    map.set(primary, primary)
  }
  // Every subagent id maps to itself.
  for (const subagent of getSubagentIds()) {
    map.set(subagent, subagent)
  }
  // Walk the canonical registry looking for alias entries.
  // Currently only `orchestrator` (alias → heidi) exists.
  for (const entry of getAllCanonicalAgents()) {
    if (entry.alias) {
      map.set(entry.id, entry.alias) // e.g. orchestrator → heidi
    }
  }
  return map
})()

/**
 * Resolves any agent id to its canonical primary identity.
 *
 * Normalization: trim + lowercase (matching `normalizeSpecialistId`), then
 * alias lookup. E.g.:
 *   "heidi"       → "heidi"
 *   "orchestrator" → "heidi"
 *   "backend-coder" → "backend-coder"
 *   "unknown"     → undefined
 *
 * Unknown or whitespace-only ids return undefined.
 */
export function resolveCanonicalPrincipal(raw: string): string | undefined {
  const normalized = raw.trim().toLowerCase()
  if (normalized.length === 0) return undefined
  return CANONICAL_ALIAS_MAP.get(normalized)
}

/**
 * Returns true when `agentId` belongs to the canonical set of primary agents
 * (heidi / orchestrator), after canonical alias resolution.
 */
export function isPrimaryAgent(agentId: string): boolean {
  const resolved = resolveCanonicalPrincipal(agentId)
  return resolved !== undefined && CANONICAL_DELEGATING_AGENT_IDS.includes(resolved)
}

/**
 * Returns true when `agentId` is a canonical subagent (specialist).
 */
export function isCanonicalSubagent(agentId: string): boolean {
  return CANONICAL_SUBAGENT_IDS.includes(agentId.trim())
}

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
  const hasMeaningfulSummary = isMeaningfulText(r.summary)
  const hasMeaningfulEvidence = r.evidence.some((e) => isMeaningfulText(e.detail))
  if (r.status === "completed") {
    return hasMeaningfulSummary && r.evidence.length > 0
  }
  return hasMeaningfulSummary || hasMeaningfulEvidence
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

/**
 * Returns true when `path` is a repository-relative path: not absolute
 * (leading "/" or a Windows drive prefix or a backslash-rooted UNC path) and
 * containing no traversal ("..") segment. Used to reject changed-file paths
 * and ownership paths that escape the repository.
 */
export function isRepositoryRelativePath(path: string): boolean {
  const trimmed = path.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith("/")) return false
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false
  if (trimmed.startsWith("\\\\")) return false
  const segments = trimmed.split(/[\\/]/)
  return !segments.includes("..")
}

/** Zod schema: a normalized repository-relative path. */
export const zRepositoryRelativePath = z
  .string()
  .trim()
  .refine((p) => p.length > 0, { message: "path must not be empty or whitespace-only" })
  .refine(isRepositoryRelativePath, {
    message: "path must be a normalized repository-relative path (no absolute, drive, or traversal paths)",
  })

/** Zod schema for a CapabilityDescriptor; capability ids must be non-empty. */
export const zCapabilityDescriptor = z.object({
  capability: zNonEmptyId,
  allowedAgents: z.array(zNonEmptyId),
  tools: z.array(zNonEmptyId),
  mutating: z.boolean(),
  requiresHuman: z.boolean(),
  supportsParallelism: z.boolean(),
  supportsCancellation: z.boolean(),
  expectedLatencyClass: zLatencyClass,
})

/** Zod schema for a FindingRef; ids and summaries must be meaningful. */
export const zFindingRef = z.object({
  id: zNonEmptyId,
  summary: zMeaningfulString,
  severity: z.enum(["info", "warning", "critical"] as const),
  location: z.string().trim().refine((s) => s.length > 0, { message: "location must not be empty or whitespace-only" }).optional(),
})

/** Zod schema for a ChangeRef; file paths must be repo-relative. */
export const zChangeRef = z.object({
  file: zRepositoryRelativePath,
  kind: z.enum(["create", "modify", "delete"] as const),
  symbol: z.string().trim().refine((s) => s.length > 0, { message: "symbol must not be empty or whitespace-only" }).optional(),
})

/** Zod schema for an EvidenceRef; ids and details must be meaningful. */
export const zEvidenceRef = z.object({
  id: zNonEmptyId,
  kind: z.enum(["log", "test", "diff", "observation", "metric"] as const),
  detail: zMeaningfulString,
})

/** Zod schema for a SpecialistResult with required-evidence enforcement. */
export const zSpecialistResult = z
  .object({
    status: z.enum(SPECIALIST_TERMINAL_STATUSES),
    summary: zMeaningfulString,
    findings: z.array(zFindingRef),
    changes: z.array(zChangeRef),
    evidence: z.array(zEvidenceRef),
    assumptions: z.array(zMeaningfulString),
    unresolvedRisks: z.array(zMeaningfulString),
    confidence: z.number().int().min(0).max(100),
    recommendedNextAction: zMeaningfulString,
    ownershipUsed: z.array(zRepositoryRelativePath),
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
    // A completed result requires a MEANINGFUL summary and at least one
    // meaningful evidence item (whitespace-only text does not count).
    if (r.status === "completed") {
      if (!isMeaningfulText(r.summary)) {
        ctx.addIssue({ code: "custom", path: ["summary"], message: "completed result requires a meaningful summary" })
      }
      const meaningfulEvidence = r.evidence.filter((e) => isMeaningfulText(e.detail))
      if (meaningfulEvidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "completed result requires at least one meaningful evidence item",
        })
      }
    }
    // Blocked/failed requires a meaningful reason in summary or evidence.
    if (r.status === "blocked" || r.status === "failed") {
      const hasReason = isMeaningfulText(r.summary) || r.evidence.some((e) => isMeaningfulText(e.detail))
      if (!hasReason) {
        ctx.addIssue({
          code: "custom",
          path: ["summary"],
          message: `${r.status} result requires a meaningful reason in summary or evidence`,
        })
      }
    }
    // Cancelled requires a meaningful cancellation reason.
    if (r.status === "cancelled" && !isMeaningfulText(r.summary)) {
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message: "cancelled result requires a meaningful cancellation reason in the summary",
      })
    }
    // A completed result with changes must provide evidence supporting them.
    if (r.status === "completed" && r.changes.length > 0 && r.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "completed result with changes must provide evidence supporting those changes",
      })
    }
    // Duplicate ids: findings, evidence.
    {
      const seen = new Set<string>()
      for (const finding of r.findings) {
        if (seen.has(finding.id)) {
          ctx.addIssue({ code: "custom", path: ["findings"], message: `duplicate finding id "${finding.id}"` })
          break
        }
        seen.add(finding.id)
      }
    }
    {
      const seen = new Set<string>()
      for (const evidence of r.evidence) {
        if (seen.has(evidence.id)) {
          ctx.addIssue({ code: "custom", path: ["evidence"], message: `duplicate evidence id "${evidence.id}"` })
          break
        }
        seen.add(evidence.id)
      }
    }
    // Ownership paths must be unique.
    {
      const seen = new Set<string>()
      for (const path of r.ownershipUsed) {
        if (seen.has(path)) {
          ctx.addIssue({ code: "custom", path: ["ownershipUsed"], message: `duplicate ownership path "${path}"` })
          break
        }
        seen.add(path)
      }
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
    // Resolve both delegating and target to canonical principal identity.
    const delegatingPrincipal = resolveCanonicalPrincipal(d.delegatingAgent)
    const targetPrincipal = resolveCanonicalPrincipal(d.targetAgent)

    // Delegating agent must be a primary (orchestrator) id.
    if (delegatingPrincipal === undefined || !getPrimaryAgentIds().includes(delegatingPrincipal)) {
      ctx.addIssue({
        code: "custom",
        path: ["delegatingAgent"],
        message: `only canonical primary agents may delegate; "${d.delegatingAgent}" is not one`,
      })
    }

    // Target agent must exist as a canonical subagent (specialist).
    if (targetPrincipal === undefined || !getSubagentIds().includes(targetPrincipal)) {
      ctx.addIssue({
        code: "custom",
        path: ["targetAgent"],
        message: `target agent "${d.targetAgent}" is not a canonical subagent; only specialists may be delegation targets`,
      })
    }

    // Alias-aware self-delegation check: heidi → orchestrator blocked, etc.
    if (
      delegatingPrincipal !== undefined &&
      targetPrincipal !== undefined &&
      delegatingPrincipal === targetPrincipal
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["targetAgent"],
        message: `self-delegation is not allowed (${d.delegatingAgent} → ${d.targetAgent} both resolve to ${delegatingPrincipal})`,
      })
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

/** Zod schema for a WorkNode; every identifier must be non-empty. */
export const zWorkNode = z.object({
  id: zNonEmptyId,
  type: zWorkNodeType,
  dependencies: z.array(zNonEmptyId),
  fileOwnership: z.array(zNonEmptyId),
  requiredCapabilities: z.array(zNonEmptyId),
  estimatedTokens: z.number().min(0),
  estimatedDurationMs: z.number().min(0),
  priority: z.number().int(),
})
