/**
 * Routing contract barrel.
 *
 * Re-exports every routing contract module and provides deterministic JSON
 * serialization plus the decision provenance record used to bind routing
 * decisions to a repository commit.
 */

import { z } from "zod"
import type { EvidenceReference } from "./task"
import { zEvidenceReference } from "./task"

export * from "./task"
export * from "./strategy"
export * from "./agents"
export * from "./models"

/** Version of the routing policy that produced routing decisions. */
export const ROUTING_POLICY_VERSION = "1.0.0"

/** Immutable record of a routing decision, bound to a repository commit. */
export interface RoutingDecisionRecord {
  decisionId: string
  kind: string
  payload: unknown
  evidence: EvidenceReference[]
  repositorySha: string
  policyVersion: string
  /** ISO 8601 timestamp of when the decision was bound. */
  timestamp: string
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

/** Zod schema for a RoutingDecisionRecord. */
export const zRoutingDecisionRecord = z.object({
  decisionId: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  evidence: z.array(zEvidenceReference),
  repositorySha: z.string(),
  policyVersion: z.string(),
  timestamp: z.string(),
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
 * Binds a routing decision to a repository commit.
 * Uses the current ROUTING_POLICY_VERSION and an ISO 8601 timestamp.
 */
export function bindDecisionToSha(
  decisionId: string,
  kind: string,
  payload: unknown,
  repositorySha: string,
  evidence: EvidenceReference[],
): RoutingDecisionRecord {
  return {
    decisionId,
    kind,
    payload,
    evidence,
    repositorySha,
    policyVersion: ROUTING_POLICY_VERSION,
    timestamp: new Date().toISOString(),
  }
}
