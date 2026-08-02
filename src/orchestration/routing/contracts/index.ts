/**
 * Routing contract barrel.
 *
 * Re-exports every routing contract module and provides deterministic JSON
 * serialization plus the decision provenance record used to bind routing
 * decisions to a repository commit.
 */

import { z } from "zod"
import { canonicalClone } from "./canonical"
import type { DelegationDecision } from "./agents"
import { zDelegationDecision, isCanonicalSubagent } from "./agents"
import type { ModelTier } from "./models"
import { zModelTier, validateDegradationFallback } from "./models"
import {
  type ClassificationResult,
  type ExecutionStrategy,
  type RoutingInputEvidence,
  type ScoredTask,
  zClassificationResult,
  zExecutionStrategy,
  zNonEmptyId,
  zRoutingInputEvidence,
  zScoredTask,
  zVersionId,
} from "./task"
import { deepFreeze } from "./immutability"

export * from "./task"
export * from "./strategy"
export * from "./agents"
export * from "./models"
export * from "./immutability"

/** Version of the routing policy that produced routing decisions. */
export const ROUTING_POLICY_VERSION = "1.0.0"

/** Version of the score weights that produced the recorded scores. */
export const ROUTING_WEIGHTS_VERSION = "1.0.0"

/** Terminal outcome of a routed task (document section 13). */
export type RoutingOutcome = "pending" | "success" | "failed" | "superseded" | "cancelled"

/**
 * Immutable record of a routing decision, bound to a repository commit
 * (document section 13). Records are immutable after write; a correction is
 * a new record whose `supersedes` references the decisionId it replaces.
 */
export interface RoutingDecisionRecord {
  taskId: string
  /** Stable identifier of this decision record. */
  decisionId: string
  /** Exact 40-hex commit SHA the decision was made against. */
  repositorySha: string
  /** ISO-8601 timestamp of when the decision was bound. */
  timestamp: string
  routingPolicyVersion: string
  weightsVersion: string
  /** Raw routing inputs recorded at decision time (document section 5.4). */
  inputEvidence: RoutingInputEvidence[]
  /** Deterministic rule ids that fired. */
  rulesApplied: string[]
  /** True when an LLM fallback was consulted. */
  modelFallbackUsed: boolean
  classification: ClassificationResult
  scores: ScoredTask
  selectedStrategy: ExecutionStrategy
  rejectedStrategies: Array<{ strategy: ExecutionStrategy; reason: string }>
  specialistCandidates: string[]
  delegationDecisions: DelegationDecision[]
  modelCandidates: Array<{ tier: ModelTier; provider?: string; reason: string }>
  selectedTier: ModelTier
  fallback: ModelTier[]
  confidence: number
  outcome?: RoutingOutcome
  /** decisionId of the record this record corrects or supersedes. */
  supersedes?: string
}

/** Inputs required to bind a routing decision to a repository commit. */
export interface BindDecisionOptions {
  taskId: string
  decisionId: string
  repositorySha: string
  /** ISO-8601; defaults to the current time when omitted. */
  timestamp?: string
  weightsVersion: string
  inputEvidence: RoutingInputEvidence[]
  rulesApplied: string[]
  modelFallbackUsed: boolean
  classification: ClassificationResult
  scores: ScoredTask
  selectedStrategy: ExecutionStrategy
  rejectedStrategies: Array<{ strategy: ExecutionStrategy; reason: string }>
  specialistCandidates: string[]
  delegationDecisions: DelegationDecision[]
  modelCandidates: Array<{ tier: ModelTier; provider?: string; reason: string }>
  selectedTier: ModelTier
  fallback: ModelTier[]
  confidence: number
  outcome?: RoutingOutcome
  supersedes?: string
}

/**
 * Serializes `value` to deterministic canonical JSON.
 *
 * Object keys are sorted recursively and undefined values are omitted, so
 * objects that differ only in key insertion order serialize identically.
 * Values that are not JSON-safe (cycles, bigint, symbol, function, non-finite
 * numbers, Map, Set, class instances, RegExp, Promise, typed arrays,
 * `undefined` array entries, sparse arrays) throw a clear
 * Error("non-serializable value").
 */
export { canonicalJson, parseCanonicalJson, canonicalClone, isCanonicalSerializable } from "./canonical"

/** Zod schema for a RoutingDecisionRecord with strict field validation. */
export const zRoutingDecisionRecord = z
  .object({
    taskId: zNonEmptyId,
    decisionId: zNonEmptyId,
    repositorySha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "repositorySha must be a 40-hex commit SHA"),
    timestamp: z.string().datetime(),
    routingPolicyVersion: zVersionId,
    weightsVersion: zVersionId,
    inputEvidence: z.array(zRoutingInputEvidence).min(
      1,
      "routing decision input evidence must contain at least one entry",
    ),
    rulesApplied: z.array(zNonEmptyId),
    modelFallbackUsed: z.boolean(),
    classification: zClassificationResult,
    scores: zScoredTask,
    selectedStrategy: zExecutionStrategy,
    rejectedStrategies: z.array(
      z.object({
        strategy: zExecutionStrategy,
        reason: zNonEmptyId,
      }),
    ),
    specialistCandidates: z.array(zNonEmptyId),
    delegationDecisions: z.array(zDelegationDecision),
    modelCandidates: z.array(
      z.object({
        tier: zModelTier,
        provider: z.string().optional(),
        reason: zNonEmptyId,
      }),
    ),
    selectedTier: zModelTier,
    fallback: z.array(zModelTier),
    confidence: z.number().min(0).max(100),
    outcome: z
      .enum(["pending", "success", "failed", "superseded", "cancelled"] as const)
      .optional(),
    supersedes: zNonEmptyId.optional(),
  })
  .superRefine((r, ctx) => {
    // ── Evidence uniqueness within each scope ──────────────────────────
    const inputEvidenceIds = r.inputEvidence.map((e) => `${e.signal}:${String(e.value)}:${e.source}`)
    {
      const seen = new Set<string>()
      for (const key of inputEvidenceIds) {
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["inputEvidence"],
            message: "input evidence entries must be unique by signal/value/source",
          })
          break
        }
        seen.add(key)
      }
    }
    // ── Rules applied must be unique ───────────────────────────────────
    {
      const seen = new Set<string>()
      for (const rule of r.rulesApplied) {
        if (seen.has(rule)) {
          ctx.addIssue({ code: "custom", path: ["rulesApplied"], message: "rulesApplied must be unique" })
          break
        }
        seen.add(rule)
      }
    }
    // ── Selected strategy not in rejected strategies; rejections unique ─
    for (const rejected of r.rejectedStrategies) {
      if (rejected.strategy === r.selectedStrategy) {
        ctx.addIssue({
          code: "custom",
          path: ["rejectedStrategies"],
          message: "selected strategy must not appear in rejectedStrategies",
        })
      }
    }
    {
      const seen = new Set<string>()
      for (const rejected of r.rejectedStrategies) {
        if (seen.has(rejected.strategy)) {
          ctx.addIssue({
            code: "custom",
            path: ["rejectedStrategies"],
            message: "rejected strategies must be unique",
          })
          break
        }
        seen.add(rejected.strategy)
      }
    }
    // Rejected reasons meaningful and trimmed.
    for (const rejected of r.rejectedStrategies) {
      if (rejected.reason.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["rejectedStrategies"],
          message: "rejected strategy reasons must be meaningful (non-whitespace)",
        })
      }
    }
    // ── Fallback: shared degradation-only validator ─────────────────────
    // The record's fallback must use the SAME degradation-only policy as the
    // model-selection schema (no duplicated or divergent fallback logic).
    const fallbackProblem = validateDegradationFallback(r.selectedTier, r.fallback)
    if (fallbackProblem !== undefined) {
      ctx.addIssue({ code: "custom", path: ["fallback"], message: fallbackProblem })
    }
    // ── Fallback provenance must agree ──────────────────────────────────
    // modelFallbackUsed (record level) must exactly equal the nested
    // classification.usedModelFallback — no contradictory provenance.
    if (r.modelFallbackUsed !== r.classification.usedModelFallback) {
      ctx.addIssue({
        code: "custom",
        path: ["modelFallbackUsed"],
        message: `modelFallbackUsed (${r.modelFallbackUsed}) must equal classification.usedModelFallback (${r.classification.usedModelFallback})`,
      })
    }
    // ── Record-wide evidence identity must be globally unique ───────────
    // Evidence ids are unique not only within each scope but across every
    // scope in the record. A duplicated id across scopes is rejected with
    // both colliding scopes identified.
    {
      const evidenceById = new Map<string, string>()
      const scopes: Array<[string, Array<{ id: string }>]> = [
        ["classification", r.classification.evidence],
        ["scores.complexity", r.scores.evidence.complexity],
        ["scores.ambiguity", r.scores.evidence.ambiguity],
        ["scores.risk", r.scores.evidence.risk],
        ["scores.confidence", r.scores.evidence.confidence],
      ]
      for (const [scope, entries] of scopes) {
        for (const entry of entries) {
          const existing = evidenceById.get(entry.id)
          if (existing !== undefined && existing !== scope) {
            ctx.addIssue({
              code: "custom",
              path: ["evidence"],
              message: `record-wide evidence id collision: "${entry.id}" appears in both "${existing}" and "${scope}"`,
            })
          } else if (existing === undefined) {
            evidenceById.set(entry.id, scope)
          }
        }
      }
    }
    // ── Delegation decisions: taskId must match the record ─────────────
    for (const [i, decision] of r.delegationDecisions.entries()) {
      if (decision.taskId !== r.taskId) {
        ctx.addIssue({
          code: "custom",
          path: [`delegationDecisions.${i}.taskId`],
          message: `delegation decision taskId must match the record taskId (${r.taskId})`,
        })
      }
      // Uniqueness by task, delegator, target, depth.
      // (checked after the loop via a global set)
    }
    {
      const seen = new Set<string>()
      for (const decision of r.delegationDecisions) {
        const key = `${decision.taskId}|${decision.delegatingAgent}|${decision.targetAgent}|${decision.depth}`
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["delegationDecisions"],
            message: "delegation decisions must be unique by task, delegator, target, and depth",
          })
          break
        }
        seen.add(key)
      }
    }
    // ── Specialist candidates: unique canonical subagents ──────────────
    {
      const seen = new Set<string>()
      for (const candidate of r.specialistCandidates) {
        if (seen.has(candidate)) {
          ctx.addIssue({ code: "custom", path: ["specialistCandidates"], message: "specialistCandidates must be unique" })
          break
        }
        seen.add(candidate)
        if (!isCanonicalSubagent(candidate)) {
          ctx.addIssue({
            code: "custom",
            path: ["specialistCandidates"],
            message: `specialistCandidates must be canonical subagents; "${candidate}" is not one`,
          })
        }
      }
    }
    // ── Model candidates: no duplicate tier/provider combos; unique reasons ──
    {
      const seen = new Set<string>()
      for (const candidate of r.modelCandidates) {
        const combo = `${candidate.tier}|${candidate.provider ?? ""}`
        if (seen.has(combo)) {
          ctx.addIssue({
            code: "custom",
            path: ["modelCandidates"],
            message: "model candidates must not contain duplicate tier/provider combinations",
          })
          break
        }
        seen.add(combo)
        if (candidate.reason.trim().length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["modelCandidates"],
            message: "model candidate reasons must be meaningful",
          })
        }
      }
    }
    // Selected tier must exist in model candidates when candidates supplied.
    if (r.modelCandidates.length > 0 && !r.modelCandidates.some((c) => c.tier === r.selectedTier)) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedTier"],
        message: "selected tier must exist in modelCandidates when candidates are supplied",
      })
    }
    // ── Classification policy version must match record version ────────
    if (r.classification.policyVersion !== r.routingPolicyVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["classification.policyVersion"],
        message: `classification.policyVersion (${r.classification.policyVersion}) must match routingPolicyVersion (${r.routingPolicyVersion})`,
      })
    }
    // ── Scores versions must match record versions ─────────────────────
    if (r.scores.policyVersion !== r.routingPolicyVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["scores.policyVersion"],
        message: `scores.policyVersion (${r.scores.policyVersion}) must match routingPolicyVersion (${r.routingPolicyVersion})`,
      })
    }
    if (r.scores.weightsVersion !== r.weightsVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["scores.weightsVersion"],
        message: `scores.weightsVersion (${r.scores.weightsVersion}) must match weightsVersion (${r.weightsVersion})`,
      })
    }
    // ── Self-supersede ──────────────────────────────────────────────────
    if (r.supersedes === r.decisionId) {
      ctx.addIssue({ code: "custom", path: ["supersedes"], message: "a decision cannot supersede itself" })
    }
    // ── Classification evidence must be non-empty and unique ───────────
    if (r.classification.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["classification.evidence"],
        message: "classification evidence must contain at least one entry",
      })
    }
    {
      const seen = new Set<string>()
      for (const evidence of r.classification.evidence) {
        if (seen.has(evidence.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["classification.evidence"],
            message: "classification evidence ids must be unique",
          })
          break
        }
        seen.add(evidence.id)
      }
    }
    // ── Score evidence ids unique within each dimension ────────────────
    const scoreDimensions: Array<[string, Array<{ id: string }>]> = [
      ["complexity", r.scores.evidence.complexity],
      ["ambiguity", r.scores.evidence.ambiguity],
      ["risk", r.scores.evidence.risk],
      ["confidence", r.scores.evidence.confidence],
    ]
    for (const [dimension, entries] of scoreDimensions) {
      const seen = new Set<string>()
      for (const entry of entries) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["scores.evidence", dimension],
            message: `score evidence ids must be unique within the ${dimension} dimension`,
          })
          break
        }
        seen.add(entry.id)
      }
    }
    // ── Cross-dimension duplicate evidence ids rejected ────────────────
    {
      const allScoreIds = new Map<string, string>()
      for (const [dimension, entries] of scoreDimensions) {
        for (const entry of entries) {
          const existing = allScoreIds.get(entry.id)
          if (existing !== undefined && existing !== dimension) {
            ctx.addIssue({
              code: "custom",
              path: ["scores.evidence"],
              message: `cross-dimension duplicate evidence id "${entry.id}" (${existing} vs ${dimension}) is not permitted`,
            })
          } else if (existing === undefined) {
            allScoreIds.set(entry.id, dimension)
          }
        }
      }
    }
    // ── Input evidence ids or canonical identity keys must not collide ─
    {
      const seen = new Set<string>()
      for (const e of r.inputEvidence) {
        if (e.signal.trim().length === 0 || e.source.trim().length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["inputEvidence"],
            message: "input evidence signal and source must be trimmed and non-empty",
          })
        }
        const key = `signal:${e.signal}`
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["inputEvidence"],
            message: "input evidence signal names must be unique",
          })
        }
        seen.add(key)
      }
    }
  })

/**
 * Validates `value` against the routing decision record schema.
 * Returns a discriminated result: `{ ok: true, value }` or a readable
 * `{ ok: false, error }` describing the first invalid field(s).
 */
export function validateRoutingDecisionRecord(
  value: unknown,
): { ok: true; value: RoutingDecisionRecord } | { ok: false; error: string } {
  const parsed = zRoutingDecisionRecord.safeParse(value)
  if (parsed.success) {
    return { ok: true, value: parsed.data }
  }
  const details = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      return `${path}: ${issue.message}`
    })
    .join("; ")
  return { ok: false, error: details.length > 0 ? details : "invalid routing decision record" }
}

/**
 * Deep-freezes an object and all nested objects/arrays recursively so a
 * bound decision record is immutable after write (document section 13).
 * Shared with the rest of the routing layer via immutability.ts.
 */
function deepFreezeRecord<T>(value: T): T {
  return deepFreeze(value)
}

/**
 * Binds a routing decision to a repository commit (document section 13).
 *
 * Lifecycle:
 *   1. construct a candidate record from the options;
 *   2. canonically deep-clone the candidate (no shared mutable identity with
 *      the caller's objects; unsupported value types throw);
 *   3. validate the complete cloned record against zRoutingDecisionRecord and
 *      throw with a readable message when any field is invalid (SHA,
 *      timestamp, versions, nested classification/scores/delegations/
 *      strategies/models/evidence);
 *   4. deep-freeze the validated clone;
 *   5. return the immutable, independent record.
 *
 * The caller's source objects (arrays, classification, scores, delegation
 * decisions) are never frozen and never referenced by the returned record.
 * Records are immutable after write; a correction is a new record whose
 * `supersedes` references the prior decisionId.
 */
export function bindDecisionToSha(options: BindDecisionOptions): RoutingDecisionRecord {
  // 1. Construct the candidate record.
  const candidate: RoutingDecisionRecord = {
    taskId: options.taskId,
    decisionId: options.decisionId,
    repositorySha: options.repositorySha,
    timestamp: options.timestamp ?? new Date().toISOString(),
    routingPolicyVersion: ROUTING_POLICY_VERSION,
    weightsVersion: options.weightsVersion,
    inputEvidence: options.inputEvidence,
    rulesApplied: options.rulesApplied,
    modelFallbackUsed: options.modelFallbackUsed,
    classification: options.classification,
    scores: options.scores,
    selectedStrategy: options.selectedStrategy,
    rejectedStrategies: options.rejectedStrategies,
    specialistCandidates: options.specialistCandidates,
    delegationDecisions: options.delegationDecisions,
    modelCandidates: options.modelCandidates,
    selectedTier: options.selectedTier,
    fallback: options.fallback,
    confidence: options.confidence,
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...(options.supersedes !== undefined ? { supersedes: options.supersedes } : {}),
  }

  // 2. Canonically deep-clone so the returned record shares no object
  //    identity with the caller's inputs.
  const cloned = canonicalClone(candidate)

  // 3. Validate the complete record; fail closed on any invalid field.
  const parsed = zRoutingDecisionRecord.safeParse(cloned)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
        return `${path}: ${issue.message}`
      })
      .join("; ")
    throw new Error(`invalid routing decision record: ${details}`)
  }

  // 4. Deep-freeze the validated clone; 5. return it.
  return deepFreezeRecord(parsed.data)
}
