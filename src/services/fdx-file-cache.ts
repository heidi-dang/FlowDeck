/**
 * FdxFileCache — hot file/result cache for deterministic read-only tools (Requirement Q).
 *
 * Keyed by (resolved path + size + mtime) so an unchanged file returns an
 * immediate cache hit and never re-hits disk. edit/write events invalidate
 * affected entries immediately. Stale data is never served: any write to a
 * path drops its entry (and that of any path under it for directory keys).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  content: string;
  lines: string[];
  hash: string;
  storedAt: number;
}

export class FdxFileCache {
  private entries = new Map<string, CacheEntry>();
  private maxEntries: number;

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  private keyFor(p: string): string {
    try { return resolve(p) } catch { return p }
  }

  /**
   * Read a file, serving from cache when the file is unchanged.
   * Returns { content, lines, hash, cached } where cached reports whether the
   * read was satisfied from the hot cache (no disk content re-read).
   */
  read(p: string): { ok: boolean; content: string; lines: string[]; hash: string; cached: boolean; error?: string } {
    const key = this.keyFor(p);
    if (!existsSync(key)) return { ok: false, content: "", lines: [], hash: "", cached: false, error: "not found" };
    try {
      const st = statSync(key);
      const existing = this.entries.get(key);
      if (existing && existing.size === st.size && existing.mtimeMs === st.mtimeMs) {
        return { ok: true, content: existing.content, lines: existing.lines, hash: existing.hash, cached: true };
      }

      const content = readFileSync(key, "utf8");
      const lines = content.split("\n");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const entry: CacheEntry = {
        path: key,
        size: st.size,
        mtimeMs: st.mtimeMs,
        content,
        lines,
        hash,
        storedAt: Date.now(),
      };
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }
      this.entries.set(key, entry);
      return { ok: true, content, lines, hash, cached: false };
    } catch (err) {
      return { ok: false, content: "", lines: [], hash: "", cached: false, error: (err as Error).message };
    }
  }

  /**
   * Slice lines for fdx-read semantics (offset 1-based, limit).
   */
  readRange(p: string, offset?: number, limit?: number): { ok: boolean; text: string; cached: boolean; error?: string } {
    const res = this.read(p);
    if (!res.ok) return { ok: false, text: "", cached: false, error: res.error };
    const start = offset && offset > 0 ? offset - 1 : 0;
    const end = limit && limit > 0 ? start + limit : res.lines.length;
    return { ok: true, text: res.lines.slice(start, end).join("\n"), cached: res.cached };
  }

  /**
   * Invalidate entries that match a written/changed path (exact or directory prefix).
   */
  invalidate(p: string): void {
    const key = this.keyFor(p);
    this.entries.delete(key);
    const prefix = key.endsWith(sep) ? key : key + sep;
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  /** Invalidate entirely (e.g. git HEAD change). */
  invalidateAll(): void {
    this.entries.clear();
  }

  stats(): { entries: number } {
    return { entries: this.entries.size };
  }
}

export const fdxFileCache = new FdxFileCache()

/**
 * Deterministic read helper used by the fast-lane path: fdx-read semantics.
 * Returns text OR an explicit error indicator, never throws.
 */
export function cachedReadText(p: string, offset?: number, limit?: number): string {
  const res = fdxFileCache.readRange(p, offset, limit);
  if (!res.ok) return "[FDX Cache] Error: " + (res.error ?? "read failed");
  return (res.cached ? "[FDX Cache Hit] " : "[FDX Cache] ") + p + "\n" + res.text;
}
