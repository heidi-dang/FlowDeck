/**
 * FdxNativeDaemon — persistent resident native FDX process manager.
 *
 * Spawns one long-lived `fdx serve` process (per repo cwd) and keeps it
 * warm, replacing the one-shot execFileSync-per-request overhead. Speaks the
 * JSON-lines protocol: requests {"id","op","args"} over child stdin, and
 * responses matched by id to pending promises over child stdout.
 *
 * Contract: fully read-only. The daemon is never an execution authority; the
 * caller routes only deterministic read/search/outline/impact requests here
 * and falls back to a one-shot native call, then the TS fallback, on failure.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { resolveFdxBinaryPath } from "../tools/fdx-shared"

export interface FdxNativeDaemonOptions {
  /** Working directory the `fdx serve` process runs in (per-repo). */
  repo?: string;
  /** Explicit path to the fdx binary. Defaults to FDX_BINARY_PATH, then `fdx`. */
  binaryPath?: string;
  /** Max concurrently queued (in-flight) requests. Default 256. */
  maxQueued?: number;
  /** Default per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Max automatic restarts after unexpected process death. Default 8. */
  maxRestarts?: number;
}

export interface NativeDaemonStats {
  pid: number | null;
  isHealthy: boolean;
  processStarts: number;
  restarts: number;
  ipcRequests: number;
  ipcFailures: number;
  queued: number;
  inflight: number;
}

interface Pending {
  op: string;
  resolve: (value: { ok: true; value: unknown }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

export class FdxNativeDaemonError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FdxNativeDaemonError";
    this.code = code;
  }
}

export class FdxNativeDaemon {
  private readonly repo?: string;
  private readonly binaryPath?: string;
  private readonly maxQueued: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxRestarts: number;

  private child: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private requestSeq = 0;
  private buffer = "";
  private stopping = false;
  private restartCount = 0;

  private processStarts = 0;
  private restarts = 0;
  private ipcRequests = 0;
  private ipcFailures = 0;

  constructor(options: FdxNativeDaemonOptions = {}) {
    this.repo = options.repo;
    this.binaryPath = options.binaryPath ?? process.env.FDX_BINARY_PATH;
    this.maxQueued = options.maxQueued ?? 256;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
    this.maxRestarts = options.maxRestarts ?? 8;
  }

  /** Spawn the resident process if it is not already running (keeps it warm). */
  start(): void {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      if (this.child.pid && this.child.pid > 0) return;
    }
    this.spawn();
  }

  stats(): NativeDaemonStats {
    return {
      pid: this.pid,
      isHealthy: this.isHealthy(),
      processStarts: this.processStarts,
      restarts: this.restarts,
      ipcRequests: this.ipcRequests,
      ipcFailures: this.ipcFailures,
      queued: this.pending.size,
      inflight: this.pending.size,
    };
  }

  isHealthy(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Send a JSON-lines request and await the matched response. Rejects on
   * timeout, spawn failure, or an error response. Callers fall back on reject.
   */
  request<T = unknown>(op: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.pending.size >= this.maxQueued) {
      this.ipcFailures++;
      return Promise.reject(new FdxNativeDaemonError("FDX_DAEMON_QUEUE_LIMIT", "fdx native daemon request queue full; fell back"));
    }
    this.start();
    if (!this.child || !this.child.stdin?.writable) {
      this.ipcFailures++;
      return Promise.reject(new FdxNativeDaemonError("FDX_DAEMON_UNAVAILABLE", "fdx native daemon not running; fell back"));
    }

    const id = "fdx" + (this.requestSeq++).toString(36) + "-" + Date.now().toString(36);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const child = this.child;

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.ipcFailures++;
        rejectPromise(new FdxNativeDaemonError("FDX_DAEMON_TIMEOUT", `fdx native daemon request timed out (op=${op})`));
      }, timeoutMs);

      this.pending.set(id, {
        op,
        resolve: (res) => { clearTimeout(timeout); resolvePromise(res.value as T); },
        reject: (err) => { clearTimeout(timeout); rejectPromise(err); },
        timer: timeout,
        timeoutMs,
      });

      const line = JSON.stringify({ id, op, args });
      try {
        child.stdin!.write(line + "\n");
        this.ipcRequests++;
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeout);
        this.ipcFailures++;
        rejectPromise(new FdxNativeDaemonError("FDX_DAEMON_WRITE", "failed to write fdx native daemon request: " + (err as Error).message));
      }
    });
  }

  /** Gracefully stop the resident process and reject outstanding requests. */
  stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new FdxNativeDaemonError("FDX_DAEMON_STOPPED", "fdx native daemon stopped"));
      }
      this.pending.clear();
      return new Promise<void>((resolvePromise) => {
        child.once("exit", () => resolvePromise());
        child.kill();
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolvePromise();
        }, 500).unref();
      });
    }
    return Promise.resolve();
  }

  private resolveBinary(): string {
    if (this.binaryPath) {
      const resolved = resolve(this.binaryPath);
      return existsSync(resolved) ? resolved : this.binaryPath;
    }
    const detected = resolveFdxBinaryPath();
    return detected || "fdx";
  }

  private spawn(): void {
    if (this.stopping) return;
    const bin = this.resolveBinary();
    const child = spawn(bin, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.repo,
      shell: false,
    });
    this.child = child;
    this.processStarts++;
    this.buffer = "";

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (process.env.FDX_DAEMON_DEBUG === "1") process.stderr.write("[fdx-native-daemon stderr] " + chunk);
    });
    child.stdin!.on("error", () => { /* write errors handled per-request */ });

    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.onExit(code, signal);
    });
    child.once("error", (err) => {
      if (this.child === child) this.child = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        this.ipcFailures++;
        p.reject(new FdxNativeDaemonError("FDX_DAEMON_SPAWN", "fdx native daemon spawn failed: " + (err as Error).message));
      }
      this.scheduleRestart();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "string") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) {
      p.resolve({ ok: true, value: msg.value });
    } else {
      this.ipcFailures++;
      p.reject(new FdxNativeDaemonError("FDX_DAEMON_RESPONSE", String(msg.error ?? "fdx native daemon returned an error")));
    }
  }

  private onExit(_code: number | null, _signal: string | null): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.ipcFailures++;
      p.reject(new FdxNativeDaemonError("FDX_DAEMON_EXITED", "fdx native daemon process exited"));
    }
    if (!this.stopping) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    if (this.restartCount >= this.maxRestarts) {
      return; // bounded: stop auto-restarting to avoid a crash loop
    }
    this.restartCount++;
    this.restarts++;
    setTimeout(() => {
      if (this.stopping) return;
      if (!this.isHealthy()) this.spawn();
    }, 50).unref();
  }
}

export const fdxNativeDaemonFactory = {
  create(options: FdxNativeDaemonOptions = {}): FdxNativeDaemon {
    return new FdxNativeDaemon(options);
  },
};
