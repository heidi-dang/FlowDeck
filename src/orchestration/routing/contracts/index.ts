/**
 * Routing contract barrel.
 *
 * Re-exports every routing contract module and provides deterministic JSON
 * serialization plus the decision provenance record used to bind routing
 * decisions to a repository commit.
 */

import { z } from "zod"
import type { DelegationDecision } from "./agents"
import { zDelegationDecision } from "./agents"
import type { ModelTier } from "./models"
import { zModelTier } from "./models"
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
} from "./task"

export * from "./task"
export * from "./strategy"
export * from "./agents"
export * from "./models"

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
 * numbers) throw a clear Error("non-serializable value").
 */
export function canonicalJson(value: unknown): string {
  const canonical = toCanonicalValue(value, new Set<object>())
  const json = JSON.stringify(canonical)
  if (json === undefined) {
    throw new Error("non-serializable value")
  }
  return json
}

/** Parses canonical JSON produced by `canonicalJson` back into a value. */
export function parseCanonicalJson<T>(json: string): T {
  const parsed: unknown = JSON.parse(json)
  return parsed as T
}

/**
 * Recursively builds a JSON-safe deep copy with sorted keys and omitted
 * undefined object values. `ancestors` tracks the current object path so
 * cycles are detected and rejected.
 */
function toCanonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) {
    return null
  }
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-serializable value")
    }
    return value
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new Error("non-serializable value")
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (ancestors.has(value)) {
    throw new Error("non-serializable value")
  }
  ancestors.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((item) => toCanonicalValue(item, ancestors))
  } else {
    const record: Record<string, unknown> = {}
    const keys = Object.keys(value).sort()
    for (const key of keys) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) {
        continue
      }
      record[key] = toCanonicalValue(item, ancestors)
    }
    result = record
  }
  ancestors.delete(value)
  return result
}

/** Zod schema for a RoutingDecisionRecord with strict field validation. */
export const zRoutingDecisionRecord = z.object({
  taskId: zNonEmptyId,
  decisionId: zNonEmptyId,
  repositorySha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "repositorySha must be a 40-hex commit SHA"),
  timestamp: z.string().datetime(),
  routingPolicyVersion: z.string(),
  weightsVersion: z.string(),
  inputEvidence: z.array(zRoutingInputEvidence),
  rulesApplied: z.array(z.string()),
  modelFallbackUsed: z.boolean(),
  classification: zClassificationResult,
  scores: zScoredTask,
  selectedStrategy: zExecutionStrategy,
  rejectedStrategies: z.array(
    z.object({
      strategy: zExecutionStrategy,
      reason: z.string(),
    }),
  ),
  specialistCandidates: z.array(z.string()),
  delegationDecisions: z.array(zDelegationDecision),
  modelCandidates: z.array(
    z.object({
      tier: zModelTier,
      provider: z.string().optional(),
      reason: z.string(),
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
 */
function deepFreezeRecord<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value
  }
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      deepFreezeRecord(item)
    }
  }
  return value
}

/**
 * Binds a routing decision to a repository commit (document section 13).
 * Uses the current ROUTING_POLICY_VERSION and an ISO 8601 timestamp. The
 * returned record is deep-frozen: records are immutable after write, so a
 * correction is a new record whose `supersedes` references the prior one.
 */
export function bindDecisionToSha(options: BindDecisionOptions): RoutingDecisionRecord {
  const record: RoutingDecisionRecord = {
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
  return deepFreezeRecord(record)
}
