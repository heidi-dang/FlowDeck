/**
 * Result Cache
 *
 * Cache for FDX tool results with CacheKey validation, SHA/dirty-tree invalidation,
 * and TTL support. Mutations are never cached.
 */

import type { CacheKey } from "./cache-key"
import {
  buildCacheKey,
  serializeCacheKey,
  deserializeCacheKey,
  areCacheKeysEqual,
  isMutationTool,
  type CacheKeyComponents,
} from "./cache-key"

export interface CacheEntry<T = unknown> {
  key: CacheKey
  value: T
  createdAt: number
  expiresAt: number | null
  hitCount: number
  sizeBytes: number
}

export interface CacheOptions {
  /** Default TTL in milliseconds. Default: 5 minutes */
  defaultTtlMs?: number
  /** Maximum cache size in bytes. Default: 50MB */
  maxCacheSizeBytes?: number
  /** Maximum number of entries. Default: 1000 */
  maxEntries?: number
  /** Enable automatic cleanup of expired entries. Default: true */
  autoCleanup?: boolean
  /** Cleanup interval in ms. Default: 60000 (1 minute) */
  cleanupIntervalMs?: number
}

export interface CacheStats {
  hits: number
  misses: number
  evictions: number
  sizeBytes: number
  entryCount: number
  hitRate: number
}

export interface InvalidationResult {
  invalidated: number
  remaining: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024 // 50MB
const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000 // 1 minute

/**
 * Result Cache with SHA/dirty-tree invalidation and TTL support.
 *
 * Thread-safe for single-process use. Not suitable for multi-process
 * distributed caching.
 */
export class ResultCache {
  private cache = new Map<string, CacheEntry>()
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    sizeBytes: 0,
    entryCount: 0,
    hitRate: 0,
  }
  private defaultTtlMs: number
  private maxCacheSizeBytes: number
  private maxEntries: number
  private autoCleanup: boolean
  private cleanupIntervalMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private lastCleanupAt = 0

  constructor(options: CacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.maxCacheSizeBytes = options.maxCacheSizeBytes ?? DEFAULT_MAX_CACHE_SIZE
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.autoCleanup = options.autoCleanup ?? true
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS

    if (this.autoCleanup) {
      this.startCleanupTimer()
    }
  }

  /**
   * Get a value from the cache.
   */
  get<T = unknown>(key: CacheKey): T | null {
    const serialized = serializeCacheKey(key)
    const entry = this.cache.get(serialized)

    if (!entry) {
      this.stats.misses++
      this.updateHitRate()
      return null
    }

    // Check expiration
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.evict(serialized)
      this.stats.misses++
      this.updateHitRate()
      return null
    }

    // Update hit count
    entry.hitCount++
    this.stats.hits++
    this.updateHitRate()
    return entry.value as T
  }

  /**
   * Set a value in the cache with optional custom TTL.
   */
  set<T = unknown>(key: CacheKey, value: T, ttlMs?: number): void {
    // Never cache mutations
    if (isMutationTool(key.queryHash)) {
      return
    }

    const serialized = serializeCacheKey(key)
    const sizeBytes = this.estimateSize(value)
    const now = Date.now()
    const ttl = ttlMs ?? this.defaultTtlMs
    const expiresAt = ttl > 0 ? now + ttl : null

    // Evict if we're over limits
    this.ensureCapacity(sizeBytes)

    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt,
      hitCount: 0,
      sizeBytes,
    }

    // Remove existing entry if present
    const existing = this.cache.get(serialized)
    if (existing) {
      this.stats.sizeBytes -= existing.sizeBytes
    }

    this.cache.set(serialized, entry as CacheEntry)
    this.stats.sizeBytes += sizeBytes
    this.stats.entryCount = this.cache.size
  }

  /**
   * Check if a key exists and is valid (not expired).
   */
  has(key: CacheKey): boolean {
    const serialized = serializeCacheKey(key)
    const entry = this.cache.get(serialized)

    if (!entry) return false
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.evict(serialized)
      return false
    }

    return true
  }

  /**
   * Invalidate cache entries by repository and worktree.
   */
  invalidateByRepository(repositoryId: string, worktreeId: string): InvalidationResult {
    let invalidated = 0
    for (const [serialized, entry] of this.cache) {
      if (entry.key.repositoryId === repositoryId && entry.key.worktreeId === worktreeId) {
        this.evict(serialized)
        invalidated++
      }
    }
    return {
      invalidated,
      remaining: this.cache.size,
    }
  }

  /**
   * Invalidate cache entries by SHA change.
   */
  invalidateBySha(repositoryId: string, worktreeId: string, headSha: string): InvalidationResult {
    let invalidated = 0
    for (const [serialized, entry] of this.cache) {
      if (
        entry.key.repositoryId === repositoryId &&
        entry.key.worktreeId === worktreeId &&
        entry.key.headSha === headSha
      ) {
        this.evict(serialized)
        invalidated++
      }
    }
    return {
      invalidated,
      remaining: this.cache.size,
    }
  }

  /**
   * Invalidate cache entries by dirty tree fingerprint change.
   */
  invalidateByDirtyTree(
    repositoryId: string,
    worktreeId: string,
    dirtyTreeFingerprint: string
  ): InvalidationResult {
    let invalidated = 0
    for (const [serialized, entry] of this.cache) {
      if (
        entry.key.repositoryId === repositoryId &&
        entry.key.worktreeId === worktreeId &&
        entry.key.dirtyTreeFingerprint !== dirtyTreeFingerprint
      ) {
        this.evict(serialized)
        invalidated++
      }
    }
    return {
      invalidated,
      remaining: this.cache.size,
    }
  }

  /**
   * Invalidate all entries matching a specific head SHA or dirty tree fingerprint.
   * Called when repository state changes.
   */
  invalidateOnStateChange(
    repositoryId: string,
    worktreeId: string,
    newHeadSha: string,
    newDirtyTreeFingerprint: string
  ): InvalidationResult {
    let invalidated = 0
    for (const [serialized, entry] of this.cache) {
      if (
        entry.key.repositoryId === repositoryId &&
        entry.key.worktreeId === worktreeId
      ) {
        // Invalidate if SHA changed or dirty tree changed
        if (
          entry.key.headSha !== newHeadSha ||
          entry.key.dirtyTreeFingerprint !== newDirtyTreeFingerprint
        ) {
          this.evict(serialized)
          invalidated++
        }
      }
    }
    return {
      invalidated,
      remaining: this.cache.size,
    }
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear()
    this.stats.sizeBytes = 0
    this.stats.entryCount = 0
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return { ...this.stats }
  }

  /**
   * Get all cache entries (for debugging).
   */
  getEntries(): CacheEntry[] {
    return Array.from(this.cache.values())
  }

  /**
   * Get entries expiring within the given time window.
   */
  getExpiringEntries(withinMs: number): CacheEntry[] {
    const now = Date.now()
    const threshold = now + withinMs
    return Array.from(this.cache.values()).filter(
      (entry) => entry.expiresAt !== null && entry.expiresAt <= threshold
    )
  }

  /**
   * Stop the cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private evict(serialized: string): void {
    const entry = this.cache.get(serialized)
    if (entry) {
      this.stats.sizeBytes -= entry.sizeBytes
      this.cache.delete(serialized)
      this.stats.entryCount = this.cache.size
      this.stats.evictions++
    }
  }

  private ensureCapacity(newEntrySize: number): void {
    // Evict expired entries first
    this.cleanupExpired()

    // If still over limits, evict least-recently-used entries
    while (
      (this.cache.size >= this.maxEntries ||
        this.stats.sizeBytes + newEntrySize > this.maxCacheSizeBytes) &&
      this.cache.size > 0
    ) {
      const lruKey = this.findLRUEntry()
      if (lruKey) {
        this.evict(lruKey)
      } else {
        break
      }
    }
  }

  private findLRUEntry(): string | null {
    let lruKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt
        lruKey = key
      }
    }

    return lruKey
  }

  private cleanupExpired(): void {
    const now = Date.now()
    const toEvict: string[] = []

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        toEvict.push(key)
      }
    }

    for (const key of toEvict) {
      this.evict(key)
    }

    this.lastCleanupAt = now
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired()
    }, this.cleanupIntervalMs)
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0
  }

  private estimateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length * 2 // UTF-16 chars
    } catch {
      return 0
    }
  }
}

/**
 * Default cache instance with standard options.
 */
export const defaultCache = new ResultCache()

/**
 * Create a new cache with custom options.
 */
export function createResultCache(options?: CacheOptions): ResultCache {
  return new ResultCache(options)
}

/**
 * Cache entry wrapper for storing operation results with their keys.
 */
export interface CachedOperation<T = unknown> {
  key: CacheKey
  result: T
  cachedAt: number
}

/**
 * Validate that a cache key matches the current repository state.
 */
export function validateCacheKey(
  key: CacheKey,
  currentComponents: CacheKeyComponents
): boolean {
  return (
    key.repositoryId === currentComponents.repositoryId &&
    key.worktreeId === currentComponents.worktreeId &&
    key.headSha === currentComponents.headSha &&
    key.dirtyTreeFingerprint === currentComponents.dirtyTreeFingerprint &&
    key.fdxVersion === currentComponents.fdxVersion
  )
}
