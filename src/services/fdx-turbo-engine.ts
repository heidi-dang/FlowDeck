/**
 * FdxTurboEngine — resident FDX execution runtime (Requirements O, P, Q).
 *
 * Preferred routing:
 *   resident native daemon (fdx serve, persistent IPC)
 *     -> resident index (warm querySymbols/queryOutline/queryImpact — never a
 *        workspace walk once initialized)
 *     -> one-shot native FDX (runFdx)
 *     -> native TypeScript fallback
 *
 * The resident native daemon is a single long-lived "fdx serve" process (per
 * repo cwd) that keeps the native reader warm, so warm searches/outlines/
 * impacts avoid both a workspace walk AND a per-request process spawn. The
 * daemon/cache/index are never execution authorities: only deterministic
 * read-only FDX operations are routed here. Provides request multiplexing
 * (dedup of concurrent identical requests), a bounded queue, cancellation,
 * health tracking and self-restart of the daemon link.
 */

import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { FdxFileCache, fdxFileCache } from "./fdx-file-cache"
import type { FdxWorkspaceIndex, FdxWorkspaceSnapshot } from "./fdx-index"
import { FdxNativeDaemon, fdxNativeDaemonFactory, type FdxNativeDaemonOptions } from "./fdx-native-daemon"
import {
  checkFdxAvailability,
  shouldDisableFallback,
  nativeImpactFallback,
  nativeOutlineFallback,
  nativeReadFallback,
  nativeSearchFallback,
  runFdxAsync,
  FDX_TOOL_BUDGET_MS,
  remainingDeadlineMs,
  isAbortError,
} from "../tools/fdx-shared"

export interface FdxTurboOptions {
  workspace: string;
  index?: FdxWorkspaceIndex;
  daemonSocketPath?: string;
  fileCache?: FdxFileCache;
  maxQueued?: number;
  /** Injection point for tests to count/customize resident native daemon creation. */
  makeNativeDaemon?: () => FdxNativeDaemon;
  nativeDaemonOptions?: FdxNativeDaemonOptions;
}

export interface TurboReadResult {
  source: "cache" | "daemon" | "index" | "native" | "fallback";
  text: string;
}

export interface TurboEngineStats {
  processStarts: number;
  ipcRequests: number;
  ipcFailures: number;
  repoScans: number;
  cacheHits: number;
  nativeSpawns: number;
  daemonHealthy: boolean;
  isHealthy: boolean;
  queued: number;
  inflight: number;
}

export class FdxTurboEngine {
  private workspace: string;
  private index?: FdxWorkspaceIndex;
  private daemonSocketPath?: string;
  private fileCache: FdxFileCache;
  private maxQueued: number;
  private queued = 0;
  private inflight = new Map<string, unknown>();
  private daemonFailures = 0;

  private nativeDaemon: FdxNativeDaemon;
  private repoScans = 0;
  private cacheHits = 0;
  private nativeSpawns = 0;

  constructor(options: FdxTurboOptions) {
    this.workspace = options.workspace;
    this.index = options.index;
    this.daemonSocketPath = options.daemonSocketPath;
    this.fileCache = options.fileCache ?? fdxFileCache;
    this.maxQueued = options.maxQueued ?? 256;

    if (options.index) {
      // Count full-refresh events on the resident index so stats().repoScans
      // reflects every real workspace walk (cold init or explicit refresh).
      const wrapped: FdxWorkspaceIndex = options.index;
      const originalRefresh = wrapped.refresh.bind(wrapped);
      (wrapped as unknown as { refresh: (w: string) => FdxWorkspaceSnapshot }).refresh = (w: string) => {
        this.repoScans++;
        return originalRefresh(w);
      };
    }

    this.nativeDaemon = options.makeNativeDaemon
      ? options.makeNativeDaemon()
      : fdxNativeDaemonFactory.create({ repo: options.workspace, ...options.nativeDaemonOptions });
    // Warm the resident native process up front so the first warm query does
    // not pay a one-shot spawn.
    this.nativeDaemon.start();
  }

  stats(): TurboEngineStats {
    const s = this.nativeDaemon.stats();
    return {
      processStarts: s.processStarts,
      ipcRequests: s.ipcRequests,
      ipcFailures: s.ipcFailures,
      repoScans: this.repoScans,
      cacheHits: this.cacheHits,
      nativeSpawns: this.nativeSpawns,
      daemonHealthy: s.isHealthy,
      isHealthy: this.healthy,
      queued: this.queued,
      inflight: this.inflight.size,
    };
  }

  health(): { healthy: boolean; daemonFailures: number; queued: number; inflight: number; fileCacheEntries: number; daemonHealthy: boolean; processStarts: number } {
    return {
      healthy: this.healthy,
      daemonFailures: this.daemonFailures,
      queued: this.queued,
      inflight: this.inflight.size,
      fileCacheEntries: this.fileCache.stats().entries,
      daemonHealthy: this.nativeDaemon.isHealthy(),
      processStarts: this.nativeDaemon.stats().processStarts,
    };
  }

  get healthy(): boolean {
    // The resident native daemon link is healthy. When it is not, the engine
    // still serves every request through the resident index / one-shot native
    // / TS fallbacks, so daemon health is informational, not a gate.
    return this.nativeDaemon.isHealthy();
  }

  markDaemonHealthy(): void {
    this.daemonFailures = 0;
  }

  markDaemonUnavailable(): void {
    this.daemonFailures++;
  }

  private enterQueue(): boolean {
    if (this.queued >= this.maxQueued) return false;
    this.queued++;
    return true;
  }

  private leaveQueue(): void {
    this.queued = Math.max(0, this.queued - 1);
  }

  private multiplex<T>(key: string, fn: (innerSignal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    interface Subscriber {
      resolve: (val: T) => void;
      reject: (err: unknown) => void;
      signal?: AbortSignal;
      onAbort?: () => void;
    }

    interface InflightEntry {
      controller: AbortController;
      subscribers: Set<Subscriber>;
      promise: Promise<T>;
    }

    let entry = this.inflight.get(key) as InflightEntry | undefined;

    if (!entry) {
      const controller = new AbortController();
      const subscribers = new Set<Subscriber>();

      const promise = fn(controller.signal)
        .then((val) => {
          this.inflight.delete(key);
          for (const sub of subscribers) {
            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
            sub.resolve(val);
          }
          return val;
        })
        .catch((err) => {
          this.inflight.delete(key);
          for (const sub of subscribers) {
            if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
            sub.reject(err);
          }
          throw err;
        });

      entry = { controller, subscribers, promise };
      this.inflight.set(key, entry);
    }

    if (signal?.aborted) return Promise.reject(new Error("FDX_TURBO_ABORTED"));

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const activeEntry = entry!;
      const sub: Subscriber = {
        resolve: resolvePromise,
        reject: rejectPromise,
        signal,
      };

      if (signal) {
        const onAbort = () => {
          activeEntry.subscribers.delete(sub);
          signal.removeEventListener("abort", onAbort);
          if (activeEntry.subscribers.size === 0) {
            activeEntry.controller.abort();
            this.inflight.delete(key);
          }
          rejectPromise(new Error("FDX_TURBO_ABORTED"));
        };
        sub.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      activeEntry.subscribers.add(sub);
    });
  }

  /**
   * Asynchronous fdx-read: resident native daemon first (when healthy), then
   * hot file cache, then one-shot native, then TS fallback. Prefer this for
   * the wire path so repeated cold reads reuse the resident process.
   */
  async readAsync(file: string, opts: { offset?: number; limit?: number; noCache?: boolean; signal?: AbortSignal; deadline?: number } = {}): Promise<TurboReadResult> {
    const deadline = opts.deadline ?? (Date.now() + FDX_TOOL_BUDGET_MS);
    if (!this.enterQueue()) return { source: "fallback", text: nativeReadFallback(file, opts.limit, opts.offset) };
    try {
      const key = this.requestKey("read", file, String(opts.offset ?? 0), String(opts.limit ?? 0));
      return await this.multiplex(key, async (innerSignal) => {
        if (!opts.noCache) {
          const cached = this.fileCache.readRange(file, opts.offset, opts.limit);
          if (cached.ok) {
            if (cached.cached) this.cacheHits++;
            return { source: "cache", text: (cached.cached ? "[FDX Cache Hit] " : "[FDX Cache] ") + key + "\n" + cached.text };
          }
        }
        if (this.nativeDaemon.isHealthy()) {
          try {
            const value = await this.nativeDaemon.request<{ path: string; text: string }>("read", { path: resolve(file), offset: opts.offset, limit: opts.limit }, { signal: innerSignal, timeoutMs: remainingDeadlineMs(deadline) });
            this.markDaemonHealthy();
            return { source: "daemon", text: value.text };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            this.markDaemonUnavailable();
          }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["read", file];
          if (opts.offset !== undefined) cmd.push("--offset", String(opts.offset));
          if (opts.limit !== undefined) cmd.push("--limit", String(opts.limit));
          try {
            this.nativeSpawns++;
            return { source: "native", text: await runFdxAsync(cmd, { signal: innerSignal, timeoutMs: remainingDeadlineMs(deadline) }) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            if (shouldDisableFallback()) throw new Error("FDX native read failed");
          }
        }
        return { source: "fallback", text: nativeReadFallback(file, opts.limit, opts.offset) };
      }, opts.signal);
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-search fast path: resident native daemon first, then warm resident
   * index (no workspace walk), then one-shot native, then TS fallback.
   */
  async search(query: string, path?: string, noCache = false, signal?: AbortSignal, deadline?: number): Promise<TurboReadResult> {
    const totalDeadline = deadline ?? (Date.now() + FDX_TOOL_BUDGET_MS);
    if (!this.enterQueue()) return { source: "fallback", text: nativeSearchFallback(query, path ?? this.workspace) };
    try {
      const key = this.requestKey("search", query, path ?? "");
      return await this.multiplex(key, async (innerSignal) => {
        if (!noCache && this.nativeDaemon.isHealthy()) {
          try {
            const value = await this.nativeDaemon.request<Array<{ path: string; symbol: string }>>("search", { pattern: query, path }, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) });
            this.markDaemonHealthy();
            return { source: "daemon", text: this.formatSearch("FDX Native", query, value ?? []) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            this.markDaemonUnavailable();
          }
        }
        if (!noCache && this.index) {
          try {
            const matches = this.index.querySymbols(this.workspace, query, path ? [path] : undefined);
            if (matches.length > 0 || (matches.length === 0 && this.daemonSocketPath)) {
              return { source: "index", text: this.formatSearch("FDX Index", query, matches) };
            }
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            /* fall through to native */
          }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["search", query];
          if (path) cmd.push("--path", path);
          try {
            this.nativeSpawns++;
            return { source: "native", text: await runFdxAsync(cmd, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) }) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            if (shouldDisableFallback()) throw new Error("FDX native search failed");
          }
        }
        return { source: "fallback", text: nativeSearchFallback(query, path ?? this.workspace, undefined, { signal: innerSignal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
      }, signal);
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-outline fast path: resident native daemon, warm resident index, then
   * one-shot native, then TS fallback.
   */
  async outline(paths: string[], noCache = false, signal?: AbortSignal, deadline?: number): Promise<TurboReadResult> {
    const totalDeadline = deadline ?? (Date.now() + FDX_TOOL_BUDGET_MS);
    if (!this.enterQueue()) return { source: "fallback", text: nativeOutlineFallback(paths, undefined, { signal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
    try {
      const key = this.requestKey("outline", paths.join(","));
      return await this.multiplex(key, async (innerSignal) => {
        if (!noCache && this.nativeDaemon.isHealthy()) {
          try {
            const value = await this.nativeDaemon.request<Array<{ path: string; symbols: string[] }>>("outline", { paths }, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) });
            this.markDaemonHealthy();
            if (value && value.length > 0) return { source: "daemon", text: this.formatOutline("FDX Native", value) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            this.markDaemonUnavailable();
          }
        }
        if (!noCache && this.index) {
          try {
            const files = this.index.queryOutline(this.workspace, paths);
            if (files.length > 0) {
              return { source: "index", text: this.formatOutline("FDX Index", files) };
            }
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            /* fall through */
          }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["outline", ...paths];
          try {
            this.nativeSpawns++;
            return { source: "native", text: await runFdxAsync(cmd, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) }) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            if (shouldDisableFallback()) throw new Error("FDX native outline failed");
          }
        }
        return { source: "fallback", text: nativeOutlineFallback(paths, undefined, { signal: innerSignal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
      }, signal);
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-impact fast path: resident native daemon, warm resident index, then
   * one-shot native, then TS fallback.
   */
  async impact(paths: string[], noCache = false, signal?: AbortSignal, deadline?: number): Promise<TurboReadResult> {
    const totalDeadline = deadline ?? (Date.now() + FDX_TOOL_BUDGET_MS);
    if (!this.enterQueue()) return { source: "fallback", text: await nativeImpactFallback(paths, this.workspace, { signal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
    try {
      const key = this.requestKey("impact", paths.join(","));
      return await this.multiplex(key, async (innerSignal) => {
        if (!noCache && this.nativeDaemon.isHealthy()) {
          try {
            const value = await this.nativeDaemon.request<Array<{ target: string }>>("impact", { paths, root: this.workspace }, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) });
            this.markDaemonHealthy();
            if (value && value.length > 0) {
              return { source: "daemon", text: "[FDX Native] Impact\n" + value.map((v) => "  " + v.target).join("\n") };
            }
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            this.markDaemonUnavailable();
          }
        }
        if (!noCache && this.index) {
          try {
            const impact = this.index.queryImpact(this.workspace, paths);
            if (impact.changedPaths.length > 0 || impact.affectedPaths.length > 0) {
              return { source: "index", text: "[FDX Index] Impact\nchanged: " + impact.changedPaths.join(", ") + "\n" + impact.affectedPaths.map((p) => "  " + p).join("\n") };
            }
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            /* fall through */
          }
        }
        if (checkFdxAvailability()) {
          const cmd: string[] = ["impact", ...paths];
          try {
            this.nativeSpawns++;
            return { source: "native", text: await runFdxAsync(cmd, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) }) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            if (shouldDisableFallback()) throw new Error("FDX native impact failed");
          }
        }
        return { source: "fallback", text: await nativeImpactFallback(paths, this.workspace, { signal: innerSignal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
      }, signal);
    } finally {
      this.leaveQueue();
    }
  }

  /**
   * fdx-grep fast path: one-shot native grep first, then TS fallback, under
   * the same bounded queue + multiplexing. The resident native serve protocol
   * does not expose a regex grep op, so we do not route it to the daemon.
   */
  async grep(pattern: string, path?: string, opts: { context?: number; maxMatches?: number; noCache?: boolean; signal?: AbortSignal; deadline?: number } = {}): Promise<TurboReadResult> {
    const totalDeadline = opts.deadline ?? (Date.now() + FDX_TOOL_BUDGET_MS);
    if (!this.enterQueue()) return { source: "fallback", text: nativeSearchFallback(pattern, path ?? this.workspace, undefined, { signal: opts.signal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
    try {
      const key = this.requestKey("grep", pattern, path ?? "");
      return await this.multiplex(key, async (innerSignal) => {
        if (checkFdxAvailability()) {
          const cmd: string[] = ["grep", pattern];
          if (path) cmd.push("--path", path);
          if (opts.context !== undefined) cmd.push("--context", String(opts.context));
          if (opts.maxMatches !== undefined) cmd.push("--max-matches", String(opts.maxMatches));
          try {
            this.nativeSpawns++;
            return { source: "native", text: await runFdxAsync(cmd, { signal: innerSignal, timeoutMs: remainingDeadlineMs(totalDeadline) }) };
          } catch (err) {
            if (isAbortError(err) || innerSignal.aborted) throw err;
            if (shouldDisableFallback()) throw new Error("FDX native grep failed");
          }
        }
        return { source: "fallback", text: nativeSearchFallback(pattern, path ?? this.workspace, undefined, { signal: innerSignal, deadlineMs: remainingDeadlineMs(totalDeadline) }) };
      }, opts.signal);
    } finally {
      this.leaveQueue();
    }
  }

  /** Gracefully stop the resident native daemon (releases the child process). */
  async stop(): Promise<void> {
    await this.nativeDaemon.stop();
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
    if (!matches || matches.length === 0) return "[" + label + "] No matches for " + query;
    return "[" + label + "] Search: " + query + "\n" + matches.map((m) => "  " + m.path + " :: " + m.symbol).join("\n");
  }

  private formatOutline(label: string, files: Array<{ path: string; symbols: string[] }>): string {
    const linesOut: string[] = ["[" + label + "] Outline"];
    for (const file of files) {
      linesOut.push("  " + file.path);
      for (const symbol of file.symbols) linesOut.push("    " + symbol);
    }
    return linesOut.join("\n");
  }
}

export function createTurboEngine(options: FdxTurboOptions): FdxTurboEngine {
  return new FdxTurboEngine(options);
}