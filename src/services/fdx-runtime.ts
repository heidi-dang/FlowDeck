import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"

export interface FdxRuntimeOptions { cacheFile: string; maxEntries?: number; maxBytes?: number; ttlMs?: number }
export interface FdxRuntimeResult<T> { value: T; source: "cache" | "compute" | "fallback"; workspaceId: string }
interface Entry { workspaceId: string; key: string; value: unknown; updatedAt: number }

/** Optional bounded persistent intelligence cache. It never becomes an execution dependency:
 * callers provide a fallback and receive it whenever the cache is unavailable or invalid. */
export class FdxRuntime {
  private readonly maxEntries: number; private readonly maxBytes: number; private readonly ttlMs: number
  constructor(private readonly options: FdxRuntimeOptions) { this.maxEntries = options.maxEntries ?? 1000; this.maxBytes = options.maxBytes ?? 5_000_000; this.ttlMs = options.ttlMs ?? 300_000 }
  workspaceId(workspace: string): string { const path = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace); return createHash("sha256").update(path).digest("hex").slice(0, 32) }
  query<T>(workspace: string, key: string, compute: () => T, fallback: () => T): FdxRuntimeResult<T> {
    if (!key || key.length > 500 || key.includes("\0")) return { value: fallback(), source: "fallback", workspaceId: this.workspaceId(workspace) }
    const id = this.workspaceId(workspace); const now = Date.now()
    try {
      const entries = this.read().filter(e => e.workspaceId === id && now - e.updatedAt <= this.ttlMs)
      const hit = entries.find(e => e.key === key)
      if (hit) return { value: hit.value as T, source: "cache", workspaceId: id }
      const value = compute(); this.write([...entries.filter(e => e.key !== key), { workspaceId: id, key, value, updatedAt: now }]); return { value, source: "compute", workspaceId: id }
    } catch { return { value: fallback(), source: "fallback", workspaceId: id } }
  }
  invalidate(workspace: string, keyPrefix?: string): void { try { const id = this.workspaceId(workspace); this.write(this.read().filter(e => e.workspaceId !== id || (keyPrefix && !e.key.startsWith(keyPrefix)))) } catch { /* optional cache failure is non-fatal */ } }
  private read(): Entry[] { if (!existsSync(this.options.cacheFile)) return []; const parsed = JSON.parse(readFileSync(this.options.cacheFile, "utf8")); return Array.isArray(parsed) ? parsed : [] }
  private write(entries: Entry[]): void { const bounded = entries.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).slice(0, this.maxEntries); const text = JSON.stringify(bounded); if (Buffer.byteLength(text) > this.maxBytes) throw new Error("FDX_CACHE_LIMIT"); mkdirSync(dirname(this.options.cacheFile), { recursive: true }); const temporary = `${this.options.cacheFile}.${process.pid}.tmp`; writeFileSync(temporary, text, "utf8"); renameSync(temporary, this.options.cacheFile) }
}
