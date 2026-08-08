/**
 * Routing contract: agent capability and delegation records.
 *
 * Describes what specialists can do (capabilities), the shape of results
 * they return, and the nodes of a routed work graph.
 */

import { z } from "zod"
import { zNonEmptyId, zMeaningfulString, isMeaningfulText } from "./task"
import { deepFreeze } from "./immutability"
import { getAllAgentIds, getPrimaryAgentIds, getSubagentIds, getAllCanonicalAgents } from "@/services/canonical-registry"

/**
 * Normalizes a raw agent id for canonical comparison: trim + lowercase.
 * Locale-independent (toLowerCase with no locale arg). Returns "" for
 * empty/whitespace-only input so callers can reject it.
 */
export function normalizeAgentId(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Canonical agent identities derived from the canonical agent registry
 * (single source of truth). The routing contract never duplicates the
 * authoritative agent list; additions/removals propagate here automatically.
 * Deeply frozen at module load.
 */
export const CANONICAL_AGENT_IDS: readonly string[] = deepFreeze(getAllAgentIds())

/**
 * Canonical delegating agents: only primary orchestrator agents (heidi /
 * orchestrator, `delegationPolicy: "justified_only"`) may delegate.
 * Specialists (`delegationPolicy: "none"`) can never be a delegating agent.
 * Deeply frozen at module load.
 */
export const CANONICAL_DELEGATING_AGENT_IDS: readonly string[] = deepFreeze(getPrimaryAgentIds())

/**
 * Canonical subagent (specialist) ids derived from the canonical registry.
 * These are the only valid delegation targets for routing decisions.
 * Deeply frozen at module load.
 */
export const CANONICAL_SUBAGENT_IDS: readonly string[] = deepFreeze(getSubagentIds())

/**
 * Canonical alias authorization lookup. Every agent id and alias resolves to
 * its canonical principal. Deeply frozen at module load — no consumer can
 * call .set()/.delete()/.clear() (it is a plain object record, not a Map),
 * and alias authorization cannot change after module load. The lookup
 * contents participate in the routing-policy fingerprint/version gate.
 *
 * Currently `orchestrator` is an alias of `heidi` (the canonical primary);
 * both resolve to `"heidi"`. Canonical specialists map to themselves.
 */
export const CANONICAL_ALIAS_LOOKUP: Readonly<Record<string, string>> = deepFreeze(
  (() => {
    const lookup: Record<string, string> = {}
    // Every agent id maps to itself; alias ids map to their canonical id.
    for (const entry of getAllCanonicalAgents()) {
      lookup[entry.id] = entry.id
      if (entry.alias) {
        lookup[entry.id] = entry.alias
        lookup[entry.alias] = entry.alias
      }
    }
    return lookup
  })(),
)

/**
 * Resolves any agent id to its canonical principal identity.
 *
 * Normalization: trim + lowercase (via `normalizeAgentId`), then alias
 * lookup. E.g.:
 *   "heidi"        → "heidi"
 *   "orchestrator" → "heidi"
 *   "backend-coder" → "backend-coder"
 *   "unknown"      → undefined
 *
 * Unknown or whitespace-only ids return undefined. Raw requested ids may
 * remain in evidence, but authorization decisions always use this result.
 */
export function resolveCanonicalPrincipal(raw: string): string | undefined {
  const normalized = normalizeAgentId(raw)
  if (normalized.length === 0) return undefined
  return CANONICAL_ALIAS_LOOKUP[normalized]
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
 * Normalization is applied consistently before comparison.
 */
export function isCanonicalSubagent(agentId: string): boolean {
  const normalized = normalizeAgentId(agentId)
  return CANONICAL_SUBAGENT_IDS.includes(normalized)
}

/** Returns true when `agentId` is a canonical agent (target must exist). */
export function isCanonicalAgent(agentId: string): boolean {
  const normalized = normalizeAgentId(agentId)
  return CANONICAL_AGENT_IDS.includes(normalized)
}

/** Returns true when `agentId` is a canonical delegating (orchestrator) agent. */
export function isCanonicalDelegatingAgent(agentId: string): boolean {
  const normalized = normalizeAgentId(agentId)
  return CANONICAL_DELEGATING_AGENT_IDS.includes(normalized)
}

/**
 * Canonical capability identifier. A capability id names a concrete
 * capability from the canonical capability set (document section 7.2) that
 * a strategy or model floor may require.
 */
export type Capability = string

/** Expected latency class of a capability's tools. */
export type LatencyClass = "instant" | "fast" | "slow"

/** Statuses that end a specialist result; no further work is expected. Deeply frozen. */
export const SPECIALIST_TERMINAL_STATUSES = deepFreeze([
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const)

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
  /**
   * Explicit terminal reason. REQUIRED for blocked/failed/cancelled results
   * (the status word alone is not an explanation). Forbidden on completed
   * results. Must be meaningful and must not equal the status word or a
   * generic placeholder.
   */
  terminalReason?: string
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
 * Returns true when `text` is a valid terminal reason: meaningful
 * (non-empty, non-whitespace, non-placeholder) AND not merely the status
 * word or a generic failure word such as "error"/"unable"/"canceled".
 */
export function isMeaningfulTerminalReason(text: string): boolean {
  if (!isMeaningfulText(text)) return false
  const normalized = text.trim().toLowerCase()
  const statusOnlyWords = new Set([
    "blocked",
    "failed",
    "cancelled",
    "canceled",
    "error",
    "unable",
    "failure",
    "fail",
  ])
  return !statusOnlyWords.has(normalized)
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
 * Routing-owned specialist capability projection. Maps each canonical
 * subagent to the capabilities it may use. This is a routing-domain
 * projection (like SPECIALIST_TASK_CLASS); the authoritative agent list is
 * never duplicated here — the parity guard below rejects stale keys and
 * missing canonical specialists at module load.
 *
 * The canonical registry's forbiddenActions are the source of truth for
 * read-only vs mutating authority: specialists forbidden from writing files
 * are read-only (no mutation capability); the others may mutate.
 */
export const SPECIALIST_CAPABILITIES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  planner: ["planning", "read_only"],
  architect: ["architecture", "read_only"],
  researcher: ["research", "read_only"],
  mapper: ["mapping", "read_only"],
  "backend-coder": ["code mutation", "implementation"],
  "frontend-coder": ["code mutation", "UI implementation"],
  devops: ["code mutation", "infrastructure change"],
  tester: ["code mutation", "test authoring"],
  reviewer: ["independent_review", "read_only"],
  "security-auditor": ["security audit", "read_only"],
  "debug-specialist": ["code mutation", "root cause analysis"],
})

/** True when a capability authorizes mutation of repository state. */
export function isMutatingCapability(capability: string): boolean {
  return capability === "code mutation"
}

/**
 * Routing-owned mutation authority projection: canonical subagent id →
 * whether it may mutate repository state. Derived from SPECIALIST_CAPABILITIES
 * (a specialist may mutate iff it holds the "code mutation" capability).
 * Deeply frozen at module load.
 */
export const SPECIALIST_MUTATION_AUTHORITY: Readonly<Record<string, boolean>> = deepFreeze(
  (() => {
    const authority: Record<string, boolean> = {}
    for (const id of CANONICAL_SUBAGENT_IDS) {
      const capabilities = SPECIALIST_CAPABILITIES[id]
      authority[id] = capabilities !== undefined && capabilities.some(isMutatingCapability)
    }
    return authority
  })(),
)

/**
 * Returns true when `specialistId` is a canonical subagent that is
 * authorized to mutate repository state.
 */
export function canSpecialistMutate(specialistId: string): boolean {
  const normalized = normalizeAgentId(specialistId)
  return SPECIALIST_MUTATION_AUTHORITY[normalized] === true
}

/** Load-time parity guard for the specialist capability projection. */
const _specialistCapabilityParityGuard = (() => {
  const subagentSet = new Set(CANONICAL_SUBAGENT_IDS)
  const extraKeys = Object.keys(SPECIALIST_CAPABILITIES).filter((k) => !subagentSet.has(k))
  if (extraKeys.length > 0) {
    throw new Error(
      `agents: stale/unauthorised keys in SPECIALIST_CAPABILITIES: ${extraKeys.join(", ")}. ` +
        `Only canonical subagent ids are permitted.`,
    )
  }
  const missingKeys = [...subagentSet].filter((k) => !(k in SPECIALIST_CAPABILITIES))
  if (missingKeys.length > 0) {
    throw new Error(`agents: missing capability mapping for canonical specialists: ${missingKeys.join(", ")}`)
  }
})()

/**
 * Assignment-bound specialist result: binds a SpecialistResult to the task,
 * assignment, specialist identity, and capabilities that authorize it.
 */
export interface SpecialistResultEnvelope {
  taskId: string
  assignmentId: string
  specialistId: string
  /** Capabilities assigned to the specialist for this assignment. */
  assignedCapabilities: string[]
  /** Repository-relative paths the specialist was assigned to own. */
  assignedOwnership: string[]
  result: SpecialistResult
}

/**
 * Validates an assignment-bound specialist result.
 *
 * Required checks:
 * - specialistId is a canonical subagent;
 * - assigned capabilities exist and belong to the specialist (per the
 *   routing-owned capability projection);
 * - mutation claims (changes.length > 0) require at least one mutating
 *   assigned capability;
 * - read-only specialist assignments (no mutating capability) must report
 *   zero changes;
 * - reported ownership must fall within assigned ownership;
 * - completed results with changes must carry evidence supporting those
 *   changes (evidence detail must reference a changed path);
 * - the envelope taskId/assignmentId must match the result it wraps (the
 *   envelope IS the identity binding; raw result records carry no identity).
 *
 * Returns `{ ok: true }` or `{ ok: false, problems: string[] }`.
 */
export function validateSpecialistResultEnvelope(
  envelope: SpecialistResultEnvelope,
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = []

  const specialistId = normalizeAgentId(envelope.specialistId)
  if (!isCanonicalSubagent(specialistId)) {
    problems.push(`specialistId "${envelope.specialistId}" is not a canonical subagent`)
  }

  const allowedCapabilities = SPECIALIST_CAPABILITIES[specialistId] ?? []
  for (const capability of envelope.assignedCapabilities) {
    if (!allowedCapabilities.includes(capability)) {
      problems.push(`assigned capability "${capability}" does not belong to specialist "${specialistId}"`)
    }
  }

  const hasMutatingAssignment = envelope.assignedCapabilities.some(isMutatingCapability)
  const claimsChanges = envelope.result.changes.length > 0

  if (claimsChanges && !hasMutatingAssignment) {
    problems.push(
      `specialist "${specialistId}" reports ${envelope.result.changes.length} change(s) but holds no mutating capability`,
    )
  }

  // Reported ownership must fall within assigned ownership.
  for (const owned of envelope.result.ownershipUsed) {
    const canonicalOwned = normalizeRepositoryRelativePath(owned) ?? owned
    const inAssigned = envelope.assignedOwnership.some(
      (p) => (normalizeRepositoryRelativePath(p) ?? p) === canonicalOwned,
    )
    if (!inAssigned) {
      problems.push(`reported ownership path "${owned}" is outside the assigned ownership`)
    }
  }

  // Completed results with changes must carry evidence supporting them.
  if (envelope.result.status === "completed" && claimsChanges) {
    if (envelope.result.evidence.length === 0) {
      problems.push("completed result with changes must provide supporting evidence")
    } else {
      for (const change of envelope.result.changes) {
        const changePath = normalizeRepositoryRelativePath(change.file) ?? change.file
        const supported = envelope.result.evidence.some((e) => e.detail.includes(changePath))
        if (!supported) {
          problems.push(`change "${change.file}" has no supporting evidence referencing it`)
        }
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }
  return { ok: true }
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
 * Normalizes a raw file path into a canonical repository-relative path, or
 * returns undefined when the path is invalid.
 *
 * Normalization rules (transform contract: validate one representation,
 * store the canonical output):
 * - convert backslashes to forward slashes;
 * - reject absolute POSIX paths (leading "/");
 * - reject drive-absolute ("C:\abs\file.ts") and drive-relative
 *   ("C:relative.ts") Windows paths;
 * - reject UNC ("\\server\share") and device paths ("\\?\..." or
 *   "//?/...") — any path rooted at a shared-name prefix or device prefix;
 * - reject empty paths and "." (the repository root is not a file);
 * - reject ".." traversal segments anywhere;
 * - collapse repeated separators ("src//file.ts" → "src/file.ts");
 * - remove safe "." segments ("src/./file.ts" → "src/file.ts");
 * - reject NUL bytes;
 * - Unicode path characters are preserved unchanged.
 */
export function normalizeRepositoryRelativePath(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.includes("\u0000")) return undefined

  const forward = trimmed.replace(/\\/g, "/")

  // Absolute POSIX path.
  if (forward.startsWith("/")) return undefined
  // Drive-absolute or drive-relative Windows path ("C:" or "C:/" or "C:\").
  if (/^[A-Za-z]:/.test(forward)) return undefined
  // UNC or device path (starts with two slashes, or "//?/" device prefix).
  if (forward.startsWith("//")) return undefined
  // Path rooted at a single slash after drive detection is already handled.

  const rawSegments = forward.split("/")
  const segments: string[] = []
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      continue // collapse repeated separators and drop "." segments
    }
    if (segment === "..") {
      return undefined // traversal is never allowed
    }
    segments.push(segment)
  }
  const canonical = segments.join("/")
  // Reject "." and "" results (repository root is not a file).
  if (canonical.length === 0) return undefined
  return canonical
}

/**
 * Returns true when `path` is a normalized repository-relative path.
 * Equivalent to `normalizeRepositoryRelativePath(path) !== undefined &&`
 * the input is already canonical (idempotence).
 */
export function isRepositoryRelativePath(path: string): boolean {
  const canonical = normalizeRepositoryRelativePath(path)
  if (canonical === undefined) return false
  return canonical === path.trim().replace(/\\/g, "/")
}

/**
 * Zod schema: a normalized repository-relative path. The input is
 * normalized (transform contract) — the parsed value is the canonical
 * form, so no code ever validates one representation and stores another.
 */
export const zRepositoryRelativePath = z
  .string()
  .trim()
  .transform((p) => normalizeRepositoryRelativePath(p))
  .refine((p): p is string => p !== undefined, {
    message:
      "path must be a normalized repository-relative path (no absolute, drive, UNC, device, or traversal paths; repeated separators and . segments collapsed)",
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
    terminalReason: z
      .string()
      .trim()
      .refine(isMeaningfulTerminalReason, {
        message:
          "terminal reason must be meaningful and explanatory (not the status word, not a generic placeholder like error/unable/canceled)",
      })
      .optional(),
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
      // Completed results must not carry a terminal-failure reason.
      if (r.terminalReason !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["terminalReason"],
          message: "completed results must not carry a terminal reason",
        })
      }
    }
    // Blocked/failed/cancelled require an EXPLICIT terminal reason — the
    // status word or a generic placeholder is not an explanation. Evidence
    // may support the reason but cannot replace the explicit field.
    if (r.status === "blocked" || r.status === "failed" || r.status === "cancelled") {
      if (r.terminalReason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["terminalReason"],
          message: `${r.status} result requires an explicit terminalReason (the status word alone is not an explanation)`,
        })
      }
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
    if (delegatingPrincipal === undefined || !isCanonicalDelegatingAgent(d.delegatingAgent)) {
      ctx.addIssue({
        code: "custom",
        path: ["delegatingAgent"],
        message: `only canonical primary agents may delegate; "${d.delegatingAgent}" is not one`,
      })
    }

    // Target agent must exist as a canonical subagent (specialist).
    if (targetPrincipal === undefined || !isCanonicalSubagent(d.targetAgent)) {
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
