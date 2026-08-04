/**
 * Shared deep-freeze / deep-readonly utilities for routing contracts.
 *
 * Every canonical policy table, mapping, nested array, and nested object
 * must be deeply frozen at module load so mutation without an explicit
 * version bump is impossible.  Callers that need a mutable working copy
 * receive a defensive clone.
 */

/** Recursive readonly mirror — every layer of a plain value tree. */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T

/**
 * Deep‑freeze the canonical value tree in‑place.
 *
 * Contracts that need immutability call this at export time.  The frozen
 * object is returned for convenience so the caller can write:
 *
 *   export const FOO = deepFreeze({ … }) as const satisfies DeepReadonly<…>
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value
  }
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      deepFreeze(item)
    }
  }
  return value
}

/**
 * Safely clones a deeply-frozen canonical value when the caller needs a
 * mutable working copy (e.g. for local overrides before binding). Uses
 * `structuredClone` so nested arrays / objects are independent.
 */
export function cloneFrozen<T>(frozen: DeepReadonly<T>): T {
  return structuredClone(frozen) as T
}