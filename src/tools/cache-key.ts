/**
 * Cache Key
 *
 * Defines the cache key structure for FDX tool results.
 * Never cache mutations — only cache read-only operations.
 */

export interface CacheKey {
  repositoryId: string
  worktreeId: string
  headSha: string
  dirtyTreeFingerprint: string
  fdxVersion: string
  queryHash: string
}

export interface CacheKeyComponents {
  repositoryId: string
  worktreeId: string
  headSha: string
  dirtyTreeFingerprint: string
  fdxVersion: string
}

/**
 * Creates a deterministic hash from query parameters.
 */
export function hashQuery(params: unknown): string {
  const serialized = JSON.stringify(params, Object.keys(params as object).sort())
  return simpleHash(serialized)
}

/**
 * Simple string hash function for cache keys.
 * Not cryptographically secure — only used for cache key derivation.
 */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0")
}

/**
 * Build a complete cache key from its components.
 */
export function buildCacheKey(components: CacheKeyComponents, params: unknown): CacheKey {
  return {
    repositoryId: components.repositoryId,
    worktreeId: components.worktreeId,
    headSha: components.headSha,
    dirtyTreeFingerprint: components.dirtyTreeFingerprint,
    fdxVersion: components.fdxVersion,
    queryHash: hashQuery(params),
  }
}

/**
 * Serialize a cache key to a string for storage.
 */
export function serializeCacheKey(key: CacheKey): string {
  return [
    key.repositoryId,
    key.worktreeId,
    key.headSha,
    key.dirtyTreeFingerprint,
    key.fdxVersion,
    key.queryHash,
  ].join("|")
}

/**
 * Deserialize a cache key from a string.
 */
export function deserializeCacheKey(serialized: string): CacheKey | null {
  const parts = serialized.split("|")
  if (parts.length !== 6) {
    return null
  }
  const [repositoryId, worktreeId, headSha, dirtyTreeFingerprint, fdxVersion, queryHash] = parts
  if (!repositoryId || !worktreeId || !headSha || !dirtyTreeFingerprint || !fdxVersion || !queryHash) {
    return null
  }
  return { repositoryId, worktreeId, headSha, dirtyTreeFingerprint, fdxVersion, queryHash }
}

/**
 * Check if two cache keys are equal.
 */
export function areCacheKeysEqual(a: CacheKey, b: CacheKey): boolean {
  return (
    a.repositoryId === b.repositoryId &&
    a.worktreeId === b.worktreeId &&
    a.headSha === b.headSha &&
    a.dirtyTreeFingerprint === b.dirtyTreeFingerprint &&
    a.fdxVersion === b.fdxVersion &&
    a.queryHash === b.queryHash
  )
}

/**
 * MUTATION TOOLS — never cache these operations.
 * This list should be updated when new mutation tools are added.
 */
export const MUTATION_TOOL_NAMES = new Set([
  "fdx-write",
  "fdx-edit",
  "fdx-delete",
  "fdx-create",
  "fdx-mkdir",
  "fdx-rm",
  "fdx-mv",
  "fdx-cp",
  "fdx-git",
  "fdx-test",
  "fdx-lint",
  "fdx-context",
  "fdx-decisions",
  "codebase-state",
])

/**
 * Check if a tool is a mutation (non-cacheable) tool.
 */
export function isMutationTool(toolName: string): boolean {
  return MUTATION_TOOL_NAMES.has(toolName)
}

/**
 * Tool names that are safe to cache (read-only operations).
 */
export const CACHEABLE_TOOL_NAMES = new Set([
  "fdx-read",
  "fdx-search",
  "fdx-grep",
  "fdx-batch",
  "fdx-impact",
  "fdx-outline",
  "fdx-diff",
  "fdx-ls",
  "fdx-tree",
])

/**
 * Check if a tool is cacheable (read-only).
 */
export function isCacheableTool(toolName: string): boolean {
  return CACHEABLE_TOOL_NAMES.has(toolName)
}
