/**
 * Recursive canonical serialization and deterministic hashing.
 *
 * Produces identical output for logically equivalent nested objects:
 * - Sorts keys at every object depth
 * - Preserves array order (arrays are ordered by definition)
 * - Rejects unsupported values (symbols, functions)
 * - Handles undefined/null consistently
 * - Detects cyclic input and throws CyclicInputError
 */

export class CyclicInputError extends Error {
  public readonly code = "CYCLIC_INPUT"
  constructor() { super("Cyclic input detected in canonical serialization") }
}

const seen = new WeakSet<object>()

function canonicalSerialize(value: unknown, depth: number): string {
  if (depth > 100) throw new Error("Max recursion depth exceeded in canonical serialization")
  if (typeof value === "bigint") return `n${value.toString()}`
  if (value === null) return "null"
  if (value === undefined) return "undefined"

  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return isFinite(value) ? String(value) : "null"
  if (typeof value === "boolean") return String(value)

  if (typeof value === "symbol" || typeof value === "function") {
    throw new Error(`Cannot serialize ${typeof value} values`)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item, depth + 1)).join(",")}]`
  }

  if (typeof value === "object") {
    if (seen.has(value)) throw new CyclicInputError()
    seen.add(value)
    try {
      const keys = Object.keys(value as Record<string, unknown>).sort()
      const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize((value as Record<string, unknown>)[k], depth + 1)}`)
      return `{${pairs.join(",")}}`
    } finally {
      seen.delete(value)
    }
  }

  return String(value)
}

export function canonicalStringify(value: unknown): string {
  return canonicalSerialize(value, 0)
}

export function hashFingerprint(fingerprint: Record<string, unknown>): string {
  const canonical = canonicalStringify(fingerprint)
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(canonical)
  return hasher.digest("hex")
}
