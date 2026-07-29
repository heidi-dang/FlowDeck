/**
 * Deterministic specification hashing.
 *
 * Produces a SHA-256 hash of a contract specification such that:
 * - Field ordering is deterministic (alphabetical key sorting)
 * - Values are normalized consistently
 * - Mutable runtime state (status, timestamps) is excluded
 * - Identical specifications produce identical hashes across repeated runs
 * - Any meaningful specification change produces a different hash
 */

import type { Specification } from "../domain/specification"

/**
 * Canonical JSON serialization.
 *
 * Produces a JSON string with:
 * - Alphabetically sorted object keys at every level
 * - No extra whitespace
 * - Consistent number and boolean formatting
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null"
  }

  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (Array.isArray(value)) {
    // Sort arrays deterministically by canonical representation
    const withCanonical = value.map((item) => ({
      raw: item,
      canonical: canonicalJson(item),
    }))
    withCanonical.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
    const items = withCanonical.map((item) => item.canonical)
    return `[${items.join(",")}]`
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const pairs = keys.map((key) => {
      const strKey = JSON.stringify(key)
      const strVal = canonicalJson((value as Record<string, unknown>)[key])
      return `${strKey}:${strVal}`
    })
    return `{${pairs.join(",")}}`
  }

  return String(value)
}

/**
 * Extracts the hash-relevant content from a specification.
 * This excludes any mutable runtime state that is not part of the
 * specification's meaning.
 */
function extractHashPayload(spec: Specification): {
  requirements: readonly { id: string; description: string; priority: string; category?: string }[]
  acceptanceCriteria: readonly { id: string; description: string; condition: string; priority: string }[]
  verificationRules: readonly { id: string; description: string; scope: string; required: boolean; failureClass: string }[]
} {
  return {
    requirements: spec.requirements.map((r) => ({
      id: r.id,
      description: r.description,
      priority: r.priority,
      ...(r.category !== undefined ? { category: r.category } : {}),
    })),
    acceptanceCriteria: spec.acceptanceCriteria.map((a) => ({
      id: a.id,
      description: a.description,
      condition: a.condition,
      priority: a.priority,
    })),
    verificationRules: spec.verificationRules.map((v) => ({
      id: v.id,
      description: v.description,
      scope: v.scope,
      required: v.required,
      failureClass: v.failureClass,
    })),
  }
}

/**
 * Computes a deterministic SHA-256 hex hash for a specification.
 *
 * The hash:
 * - Uses deterministic field ordering (sorted keys)
 * - Normalizes values consistently
 * - Excludes mutable runtime state
 * - Is idempotent for identical specifications
 */
export function hashSpecification(spec: Specification): string {
  const payload = extractHashPayload(spec)
  const canonical = canonicalJson(payload)

  // Use Bun's synchronous CryptoHasher for SHA-256
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(canonical)
  return hasher.digest("hex")
}
