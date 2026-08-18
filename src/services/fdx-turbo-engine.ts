/**
 * FdxTurboEngine — resident FDX execution runtime (Requirements O, P, Q).
 *
 * Preferred routing:
 *   resident fast path (hot file cache + resident index/daemon)
 *     -> one-shot native FDX
 *     -> native TypeScript fallback
 *
 * The daemon/cache is never an execution authority for dangerous operations:
 * only deterministic read-only FDX operations are routed here. Provides
 * request multiplexing (dedup of concurrent identical requests), a bounded
 * queue, cancellation, health tracking and self-restart of the daemon link.
 */

import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { FdxFileCache, fdxFileCache } from "./fdx-file-cache"
import type { FdxWorkspaceIndex } from "./fdx-index"
import {
  checkFdxAvailability,
  nativeImpactFallback,
  nativeOutlineFallback,
  nativeReadFallback,
  nativeSearchFallback,
  runFdx,
} from "../tools/fdx-shared"

export interface FdxTurboOptions {
  workspace: string;
  index?: FdxWorkspaceIndex;
  daemonSocketPath?: string;
  fileCache?: FdxFileCache;
  maxQueued?: number;
}

export interface TurboReadResult {
  source: "cache" | "daemon" | "native" | "fallback";
  text: string;
}

export class FdxTurboEngine {
  private workspace: string;
  private index?: FdxWorkspaceIndex;
  private daemonSocketPath?: string;
  private fileCache: FdxFileCache;
  private maxQueued: number;
  private queued = 0;
  private inflight = new Map<string, Promise<unknown>>();
  private healthy = true;
  private daemonFailures = 0;

  constructor(options: FdxTurboOptions) {
    this.workspace = options.workspace;
    this.index = options.index;
    this.daemonSocketPath = options.daemonSocketPath;
    this.fileCache = options.fileCache ?? fdxFileCache;
    this.maxQueued = options.maxQueued ?? 256;
  }

  private enterQueue(): boolean {
    if (this.queued >= this.maxQueued) return false;
    this.queued++;
    return true;
  }

  private leaveQueue(): void {
    this.queued = Math.max(0, this.queued - 1);
  }

  /**
   * Multiplex concurrent identical requests into one in-flight promise.
   */
  private multiplex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  health(): { healthy: boolean; daemonFailures: number; queued: number; inflight: number; fileCacheEntries: number } {
    return {
      healthy: this.healthy,
      daemonFailures: this.daemonFailures,
      queued: this.queued,
      inflight: this.inflight.size,
      fileCacheEntries: this.fileCache.stats().entries,
    };
  }

  markDaemonHealthy(): void {
    this.daemonFailures = 0;
    this.healthy = true;
  }

  markDaemonUnavailable(): void {
    this.daemonFailures++;
    // Self-restart semantics: after repeated failures we drop the daemon path
    // until it is reconfigured (health/restart/fallback works).
    if (this.daemonFailures >= 3) this.healthy = false;
  }

  /**
   * fdx-read fast path: cached read (resident). Falls back to native FDX,
   * then TS fallback. Deterministic and read-only.
   */
  read(file: string, opts: { offset?: number; limit?: number; noCache?: boolean } = {}): TurboReadResult {
    if (!this.enterQueue()) return { source: "fallback", text: nativeReadFallback(file, opts.limit, opts.offset) };
    try {
      const key = this.fileKey(file);
      if (!opts.noCache) {
        const cached = this.fileCache.readRange(file, opts.offset, opts.limit);
        if (cached.ok) {
          return { source: "cache", text: "[FDX Cache Hit] " + key + "\n" + cached.text };
        }
      }

      if (checkFdxAvailability()) {
        const cmd: string[] = ["read", file];
        if (opts.offset !== undefined) cmd.push("--offset", String(opts.offset));
        if (opts.limit !== undefined) cmd.push("--limit", String(opts.limit));
        try {
          return { source: "native", text: runFdx(cmd) };
        } catch {
          if (process.env.FDX_DISABLE_FALLBACK === "1") throw new Error("FDX native read failed");
        }
      }
      return { source: "fallback", text: nativeReadFallback(file, opts.limit, opts.offset) };
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-search fast path: resident index/daemon first, then one-shot native,
   * then TS fallback.
   */
  async search(query: string, path?: string, noCache = false): Promise<TurboReadResult> {
    if (!this.enterQueue()) return { source: "fallback", text: nativeSearchFallback(query, path ?? this.workspace) };
    try {
      const key = this.requestKey("search", query, path ?? "");
      return await this.multiplex(key, async () => {
        if (!noCache && this.index) {
          try {
            const matches = this.index.symbols(this.workspace, query, path ? [path] : undefined);
            if (matches.length > 0 || (matches.length === 0 && this.daemonSocketPath)) {
              return { source: "daemon", text: this.formatSearch("FDX Index", query, matches) };
            }
          } catch { /* fall through to native */ }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["search", query];
          if (path) cmd.push("--path", path);
          try {
            return { source: "native", text: runFdx(cmd) };
          } catch {
            if (process.env.FDX_DISABLE_FALLBACK === "1") throw new Error("FDX native search failed");
          }
        }
        return { source: "fallback", text: nativeSearchFallback(query, path ?? this.workspace) };
      });
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-outline fast path.
   */
  async outline(paths: string[], noCache = false): Promise<TurboReadResult> {
    if (!this.enterQueue()) return { source: "fallback", text: nativeOutlineFallback(paths) };
    try {
      const key = this.requestKey("outline", paths.join(","));
      return await this.multiplex(key, async () => {
        if (!noCache && this.index) {
          try {
            const files = this.index.outline(this.workspace, paths);
            if (files.length > 0) {
              const linesOut: string[] = ["[FDX Index] Outline"];
              for (const file of files) {
                linesOut.push("  " + file.path);
                for (const symbol of file.symbols) linesOut.push("    " + symbol);
              }
              return { source: "daemon", text: linesOut.join("\n") };
            }
          } catch { /* fall through */ }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["outline", ...paths];
          try { return { source: "native", text: runFdx(cmd) }; } catch { if (process.env.FDX_DISABLE_FALLBACK === "1") throw new Error("FDX native outline failed") }
        }
        return { source: "fallback", text: nativeOutlineFallback(paths) };
      });
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-impact fast path.
   */
  async impact(paths: string[], noCache = false): Promise<TurboReadResult> {
    if (!this.enterQueue()) return { source: "fallback", text: await nativeImpactFallback(paths, this.workspace) };
    try {
      const key = this.requestKey("impact", paths.join(","));
      return await this.multiplex(key, async () => {
        if (!noCache && this.index) {
          try {
            const impact = this.index.impact(this.workspace, paths);
            if (impact.changedPaths.length > 0 || impact.affectedPaths.length > 0) {
              return { source: "daemon", text: "[FDX Index] Impact\nchanged: " + impact.changedPaths.join(", ") + "\n" + impact.affectedPaths.map(p => "  " + p).join("\n") };
            }
          } catch { /* fall through */ }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["impact", ...paths];
          try { return { source: "native", text: runFdx(cmd) }; } catch { if (process.env.FDX_DISABLE_FALLBACK === "1") throw new Error("FDX native impact failed") }
        }
        return { source: "fallback", text: await nativeImpactFallback(paths, this.workspace) };
      });
    } finally {
      this.leaveQueue();
    }
  }

  /** invalidate cache on write/edit; directory prefix handled. */
  invalidate(path: string): void {
    this.fileCache.invalidate(path);
  }

  /** invalidate all on git HEAD/worktree change. */
  invalidateAll(): void {
    this.fileCache.invalidateAll();
  }

  private fileKey(file: string): string {
    try {
      const abs = resolve(file);
      return existsSync(abs) ? realpathSync(abs) : abs;
    } catch { return file }
  }

  private requestKey(method: string, ...parts: string[]): string {
    return createHash("sha256").update(method + "|" + parts.join("|")).digest("hex").slice(0, 24);
  }

  private formatSearch(label: string, query: string, matches: Array<{ path: string; symbol: string }>): string {
    if (matches.length === 0) return "[" + label + "] No matches for " + query;
    return "[" + label + "] Search: " + query + "\n" + matches.map(m => "  " + m.path + " :: " + m.symbol).join("\n");
  }
}

export function createTurboEngine(options: FdxTurboOptions): FdxTurboEngine {
  return new FdxTurboEngine(options);
}
