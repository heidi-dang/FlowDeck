import { createHash } from "node:crypto"

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export function commandRequestFingerprint(commandId: string, commandVersion: number, input: unknown): string {
  const canonical = JSON.stringify({ commandId, commandVersion, input: canonicalize(input) })
  return createHash("sha256").update(canonical).digest("hex")
}
