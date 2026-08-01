/**
 * Deterministic hashing for TaskContracts.
 *
 * Produces a SHA-256 hash of contract content such that:
 * - Field ordering is deterministic (alphabetical key sorting)
 * - Values are normalized consistently
 * - Mutable runtime state (activatedAt) is excluded from hash input
 * - Identical contracts produce identical hashes across repeated runs
 * - Any meaningful change produces a different hash
 * - Version field is included for forward compatibility
 */

import type { TaskContract, TaskContractDraft } from "./task-contract"

/**
 * Canonical JSON serialization with deterministic ordering.
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

  if (typeof value === "bigint") {
    return String(value)
  }

  if (Array.isArray(value)) {
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
 * Extracts the hash-relevant content from a contract draft.
 * Excludes mutable runtime state (activatedAt) and the pre-computed hash itself.
 */
function extractHashPayload(draft: TaskContractDraft): {
  id: string
  version: string
  objective: string
  requirements: readonly { id: string; description: string; critical: boolean; verifiable: boolean }[]
  acceptanceCriteria: readonly { id: string; description: string; critical: boolean; testable: boolean }[]
  constraints: readonly { id: string; description: string; enforce: boolean }[]
  exclusions: readonly string[]
  requiredEvidence: readonly { type: string; path?: string; description: string }[]
  requiredVerification: readonly { type: string; command?: string; description: string }[]
  startingSha: string
  allowedMutationScope: { allowedPaths: readonly string[]; deniedPaths: readonly string[]; maxFiles: number }
  approvalGates: readonly { type: string; authority?: string }[]
  createdAt: string
} {
  return {
    id: draft.id,
    version: draft.version,
    objective: draft.objective,
    requirements: draft.requirements.map((r) => ({
      id: r.id,
      description: r.description,
      critical: r.critical,
      verifiable: r.verifiable,
    })),
    acceptanceCriteria: draft.acceptanceCriteria.map((a) => ({
      id: a.id,
      description: a.description,
      critical: a.critical,
      testable: a.testable,
    })),
    constraints: draft.constraints.map((c) => ({
      id: c.id,
      description: c.description,
      enforce: c.enforce,
    })),
    exclusions: draft.exclusions,
    requiredEvidence: draft.requiredEvidence.map((e) => ({
      type: e.type,
      path: e.path,
      description: e.description,
    })),
    requiredVerification: draft.requiredVerification.map((v) => ({
      type: v.type,
      command: v.command,
      description: v.description,
    })),
    startingSha: draft.startingSha,
    allowedMutationScope: {
      allowedPaths: draft.allowedMutationScope.allowedPaths,
      deniedPaths: draft.allowedMutationScope.deniedPaths,
      maxFiles: draft.allowedMutationScope.maxFiles,
    },
    approvalGates: draft.approvalGates.map((g) => ({
      type: g.type,
      authority: g.authority,
    })),
    createdAt: draft.createdAt.toISOString(),
  }
}

/**
 * Computes a deterministic SHA-256 hex hash for a contract draft.
 *
 * The hash:
 * - Uses deterministic field ordering (sorted keys)
 * - Normalizes values consistently
 * - Excludes mutable runtime state (activatedAt) and the hash field itself
 * - Is idempotent for identical drafts
 */
export function hashContract(draft: TaskContractDraft): string {
  const payload = extractHashPayload(draft)
  const canonical = canonicalJson(payload)

  // Use Bun's synchronous CryptoHasher for SHA-256
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(canonical)
  return hasher.digest("hex")
}

/**
 * Verifies that a contract's hash matches its content.
 * Returns true if the contract is internally consistent.
 */
export function verifyContractHash(contract: TaskContract): boolean {
  const draft: TaskContractDraft = {
    id: contract.id,
    version: contract.version,
    objective: contract.objective,
    requirements: contract.requirements,
    acceptanceCriteria: contract.acceptanceCriteria,
    constraints: contract.constraints,
    exclusions: contract.exclusions,
    requiredEvidence: contract.requiredEvidence,
    requiredVerification: contract.requiredVerification,
    startingSha: contract.startingSha,
    allowedMutationScope: contract.allowedMutationScope,
    approvalGates: contract.approvalGates,
    createdAt: contract.createdAt,
  }
  return hashContract(draft) === contract.hash
}
