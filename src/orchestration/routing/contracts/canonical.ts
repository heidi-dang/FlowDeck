/**
 * Canonical JSON serialization for the routing layer.
 *
 * Provides deterministic serialization (sorted keys, omitted undefined object
 * properties) plus canonical deep cloning. Arrays are stricter than objects:
 * `undefined` entries and sparse arrays (holes) are rejected so two
 * semantically different accepted values can never serialize identically.
 *
 * Documented canonical rules:
 * - object keys are sorted recursively;
 * - `undefined` OBJECT properties are omitted (the key disappears);
 * - `undefined` ARRAY entries are rejected;
 * - sparse arrays (holes) are rejected;
 * - unsupported values and cycles are rejected.
 */

/** Returns true when `value` is a plain object (Object.prototype or null proto). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
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
 * non-finite numbers, and cyclic graphs.
 */
export function toCanonicalValue(value: unknown, ancestors: Set<object>): unknown {
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
    // Detect holes by index ownership: a sparse array has an index without
    // an own property. `.map()` would silently skip holes, so probe every
    // index directly.
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        ancestors.delete(value)
        throw new Error("non-serializable value: sparse arrays are not supported")
      }
    }
    const result: unknown[] = []
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i]
      if (item === undefined) {
        ancestors.delete(value)
        throw new Error("non-serializable value: undefined array entries are not supported")
      }
      result.push(toCanonicalValue(item, ancestors))
    }
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
 * Serializes `value` to deterministic canonical JSON.
 *
 * Object keys are sorted recursively and undefined values are omitted, so
 * objects that differ only in key insertion order serialize identically.
 * Values that are not JSON-safe (cycles, bigint, symbol, function, non-finite
 * numbers, Map, Set, class instances, RegExp, Promise, typed arrays,
 * `undefined` array entries, sparse arrays) throw a clear
 * Error("non-serializable value").
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
 * Canonically deep-clones `value` with no shared mutable object identity:
 * every nested object/array is recreated, keys are sorted, undefined values
 * are dropped from objects, `undefined` array entries and sparse arrays are
 * rejected, and unsupported types are rejected (see `toCanonicalValue`).
 */
export function canonicalClone<T>(value: T): T {
  return toCanonicalValue(value, new Set<object>()) as T
}

/**
 * Returns true when `value` can be canonically serialized without error.
 * `undefined` is accepted (a top-level undefined object property is omitted
 * per the documented canonical rule; the value itself is handled by callers).
 */
export function isCanonicalSerializable(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  try {
    canonicalJson(value)
    return true
  } catch {
    return false
  }
}