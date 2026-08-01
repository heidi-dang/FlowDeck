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
  zVersionId,
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
 * numbers, Map, Set, class instances, RegExp, Promise, typed arrays) throw a
 * clear Error("non-serializable value").
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
 *
 * Supported values: plain objects, arrays, strings, booleans, finite numbers,
 * null, and Dates (serialized to ISO-8601 strings). Every other value type is
 * rejected with Error("non-serializable value"): Map, Set, WeakMap, WeakSet,
 * typed arrays, class instances, RegExp, Promise, symbol, bigint, function,
 * non-finite numbers, and cyclic graphs. The plain-object prototype check
 * ensures a class instance is never silently coerced into a `{}` record.
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
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("non-serializable value")
    }
    ancestors.add(value)
    const result = value.map((item) => toCanonicalValue(item, ancestors))
    ancestors.delete(value)
    return result
  }
  if (!isPlainObject(value)) {
    throw new Error("non-serializable value")
  }
  if (ancestors.has(value)) {
    throw new Error("non-serializable value")
  }
  ancestors.add(value)
  const record: Record<string, unknown> = {}
  const keys = Object.keys(value).sort()
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) {
      continue
    }
    record[key] = toCanonicalValue(item, ancestors)
  }
  ancestors.delete(value)
  return record
}

/**
 * Returns true when `value` is a plain object: its prototype is either
 * Object.prototype or null (Object.create(null)). Class instances, Maps,
 * Sets, RegExps, Promises, and typed arrays fail this check and are rejected.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Canonically deep-clones `value` with no shared mutable object identity:
 * every nested object/array is recreated, keys are sorted, undefined values
 * are dropped, and unsupported types are rejected (see `toCanonicalValue`).
 */
export function canonicalClone<T>(value: T): T {
  return toCanonicalValue(value, new Set<object>()) as T
}

/** Zod schema for a RoutingDecisionRecord with strict field validation. */
export const zRoutingDecisionRecord = z.object({
  taskId: zNonEmptyId,
  decisionId: zNonEmptyId,
  repositorySha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "repositorySha must be a 40-hex commit SHA"),
  timestamp: z.string().datetime(),
  routingPolicyVersion: zVersionId,
  weightsVersion: zVersionId,
  inputEvidence: z.array(zRoutingInputEvidence),
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
