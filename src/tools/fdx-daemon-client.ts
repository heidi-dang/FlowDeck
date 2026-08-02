/**
 * fdx-daemon-client.ts — TypeScript client for the fdxd daemon (protocol v1).
 *
 * Responsibilities (Dev 3 Task 2):
 * - Discover a compatible daemon (unix socket path derived from uid + project).
 * - Spawn-on-demand when none is running; never spawn per request.
 * - `hello` capability handshake with protocol-version validation.
 * - Request/response correlation by id; bounded response handling.
 * - Timeouts; cancellation requests; daemon failure detection.
 * - Fallback ladder: daemon -> one-shot native fdx spawn -> TS fallback.
 * - Fallback reason reporting (structured, not silent).
 *
 * IMPORTANT: this module is additive. Existing fdx-* tools keep using the
 * one-shot spawn path until integration (Dev 3 Task 11). The client is used
 * directly by the daemon tests and is the surface the tools adopt later.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  resolveFdxBinaryPath,
  shouldDisableFallback,
  runFdx,
  nativeReadFallback,
  nativeSearchFallback,
  nativeLsFallback,
  nativeOutlineFallback,
  nativeGitFallback,
} from "./fdx-shared"

// ─── Constants ─────────────────────────────────────────────────────────────

/** Protocol version the client speaks. Must match the daemon's `v` field. */
export const PROTOCOL_VERSION = 1

/** Max size of a single NDJSON message (must match the daemon). */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Bounded response buffer (matches daemon). */
const MAX_OUTPUT_BYTES = MAX_MESSAGE_BYTES

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** How long to wait for the daemon to complete its hello handshake. */
export const HANDSHAKE_TIMEOUT_MS = 5_000

/** How long to wait for the daemon process to appear ready. */
export const STARTUP_TIMEOUT_MS = 5_000

/** How many consecutive failures before we stop trying to start a daemon. */
export const MAX_STARTUP_ATTEMPTS = 1

/** Daemon idle timeout when we spawn it (seconds) — matches fdxd default. */
export const DAEMON_IDLE_SECONDS = 300

type DaemonConnectionState =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "ready"
  | "closing"
  | "failed"

export interface DaemonCapabilities {
  protocol: number
  methods: string[]
  commands: string[]
  transport: string
  version: string
  pid: number
  activeInterruption: boolean
}

export interface HelloResult {
  client: string
  clientVersion: string
  capabilities: DaemonCapabilities
}

export interface QueryResult {
  stdout?: string
  exitCode?: number
  durationMs?: number
  cached?: boolean
  result?: unknown
}

export interface DaemonError {
  code: string
  message: string
}

export interface DaemonResponse {
  v: number
  id: number | null
  ok: boolean
  event?: string
  result?: unknown
  error?: DaemonError
}

export interface DaemonRequest {
  v: number
  id: number | null
  method: string
  params?: Record<string, unknown>
}

// ─── Task 4: typed read-only batch protocol ───────────────────────────────
// Mirrors crates/fdx/src/batch/mod.rs — one canonical schema across daemon,
// CLI, TS client, fallback, and capability metadata.

/** Parameter bag for a single batch operation (all fields optional). */
export interface OperationParams {
  file?: string
  mode?: string
  symbol?: string
  limit?: number
  offset?: number
  pattern?: string
  paths?: string[]
  contextLines?: number
  fixedStrings?: boolean
  caseSensitive?: boolean
  kindFilter?: string
  maxMatches?: number
  noCache?: boolean
  depth?: number
  minLines?: number
  targets?: string[]
  direction?: string
  root?: string
  source?: string
}

/** One typed operation inside a batch. */
export interface BatchOperation {
  id: string
  op: string
  params: OperationParams
}

/** Error payload for a failed operation. */
export interface BatchOpError {
  code: string
  message: string
}

/** Response for a single batch operation. */
export interface OperationResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: BatchOpError
}

/** Whole-batch response (version 1). */
export interface BatchResponse {
  version: number
  responses: OperationResponse[]
  failedFast: boolean
  staleSnapshot: boolean
}

/** Capability metadata for a hosted tool (mirrors batch/registry.rs). */
export interface ToolDescriptor {
  name: string
  readOnly: boolean
  supportsStreaming: boolean
  supportsCancellation: boolean
  supportsBatching: boolean
  cachePolicy: "none" | "run" | "repository"
  expectedLatencyClass: "instant" | "fast" | "slow"
  maximumOutputBytes: number
  negativeCacheEligible: boolean
}

export interface CapabilitiesPayload {
  descriptors: ToolDescriptor[]
}


export type FallbackReason =
  | "ok" // daemon served the request
  | "daemon-unavailable" // no binary / socket unreachable
  | "daemon-incompatible" // protocol version mismatch
  | "daemon-not-ready" // startup/handshake timeout
  | "daemon-crashed" // connection dropped mid-request
  | "daemon-timeout" // request exceeded timeout
  | "command-not-hosted" // E_UNSUPPORTED from daemon
  | "native-unavailable" // no fdx binary either
  | "disabled" // FDX_DISABLE_FALLBACK=1

export interface ClientResult<T> {
  value?: T
  fallback: FallbackReason
  reason?: string
  metrics?: {
    transport: "daemon" | "one-shot" | "ts-fallback"
    durationMs: number
    daemonPid?: number
    cached?: boolean
  }
}

// ─── Daemon discovery ───────────────────────────────────────────────────────

/** Socket path the daemon listens on for a given project directory. */
export function daemonSocketPath(projectDir: string): string {
  // User-scoped, per-project: no cross-user collision, no cross-worktree
  // contamination. Uses XDG_RUNTIME_DIR when available, otherwise private user-owned dir.
  // Path format: <runtime-dir>/fdxd-<uid>-<sha256(projectDir)>.sock
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  const hash = hashString(resolve(projectDir))

  // Use XDG_RUNTIME_DIR on Linux, otherwise a private user-owned directory
  let runtimeDir: string
  if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
    runtimeDir = process.env.XDG_RUNTIME_DIR
  } else {
    // Create a private user-owned runtime directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir()
    runtimeDir = join(homeDir, ".local", "run", "fdxd")
    // Ensure directory exists with restricted permissions
    try {
      const fs = require("node:fs")
      if (!fs.existsSync(runtimeDir)) {
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
      }
    } catch {
      // Fallback to tmpdir if we can't create the directory
      runtimeDir = tmpdir()
    }
  }

  return join(runtimeDir, `fdxd-${uid}-${hash}.sock`)
}

/** Deterministic SHA-256 hash for a path (collision-resistant). */
export function hashString(s: string): string {
  const crypto = require("node:crypto")
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16)
}

/** Startup lock for single-flight daemon startup. */
class StartupLock {
  private lockPath: string
  private acquired = false

  constructor(socketPath: string) {
    this.lockPath = socketPath + ".lock"
  }

  /** Acquire the startup lock. Returns true if acquired, false if another process holds it. */
  async acquire(): Promise<boolean> {
    const fs = require("node:fs")
    try {
      // Use O_EXCL for atomic creation
      const fd = fs.openSync(this.lockPath, "wx")
      fs.closeSync(fd)
      this.acquired = true
      return true
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Lock exists, check if it's stale
        return await this.checkStaleLock()
      }
      throw e
    }
  }

  /** Check if existing lock is stale (daemon not running). */
  private async checkStaleLock(): Promise<boolean> {
    const fs = require("node:fs")
    try {
      const stat = fs.statSync(this.lockPath)
      // If lock is older than 5 minutes, consider it stale
      if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
        // Try to remove stale lock
        try {
          fs.unlinkSync(this.lockPath)
          return await this.acquire()
        } catch {
          return false
        }
      }
      return false
    } catch {
      return false
    }
  }

  /** Release the startup lock. */
  release(): void {
    if (this.acquired) {
      try {
        const fs = require("node:fs")
        fs.unlinkSync(this.lockPath)
      } catch {
        // Ignore errors on release
      }
      this.acquired = false
    }
  }
}

/** The daemon binary path: FDX_DAEMON_BINARY_PATH, sibling of the resolved
 * fdx binary, the repo's target/debug dirs, then "fdxd" on PATH. */
export function resolveDaemonBinaryPath(): string | null {
  const env = process.env.FDX_DAEMON_BINARY_PATH
  if (env && existsSync(resolve(env))) return resolve(env)
  const binName = process.platform === "win32" ? "fdxd.exe" : "fdxd"
  // Sibling of the resolved fdx binary (e.g. target/debug/fdx -> fdxd).
  const fdxBin = resolveFdxBinaryPath()
  if (fdxBin && fdxBin !== "fdx") {
    const sibling = join(resolve(fdxBin, ".."), binName)
    if (existsSync(sibling)) return sibling
  }
  // Repo debug builds (matches the parity-script convention). __dirname is
  // <repo>/src/tools (or <repo>/dist/tools when compiled), so the repo root
  // is two levels up.
  const repoRoot = resolve(__dirname, "..", "..")
  for (const p of [join(repoRoot, "target", "debug", binName), join(repoRoot, "crates", "fdx", "target", "debug", binName)]) {
    if (existsSync(p)) return p
  }
  const probe = spawnSync(binName, ["--version"], { stdio: "ignore", shell: false })
  if (!probe.error && probe.status !== null) return binName
  return null
}

/** True if a daemon is currently listening on the socket. Accepts a socket
 * path directly or a project directory (for backwards-compatible callers). */
export function isDaemonRunning(projectDirOrSocket: string): Promise<boolean> {
  const sock = projectDirOrSocket.includes(".sock")
    ? projectDirOrSocket
    : daemonSocketPath(projectDirOrSocket)
  if (!existsSync(sock)) return Promise.resolve(false)
  // Stale socket check: a live listener accepts; a dead one refuses.
  return new Promise<boolean>((resolvePromise) => {
    try {
      const net = require("node:net") as typeof import("node:net")
      const c = net.createConnection(sock)
      c.setTimeout(500)
      c.on("connect", () => {
        c.destroy()
        resolvePromise(true)
      })
      c.on("error", () => resolvePromise(false))
      c.on("timeout", () => {
        c.destroy()
        resolvePromise(false)
      })
    } catch {
      resolvePromise(false)
    }
  })
}

export class DaemonConnection {
  private state: DaemonConnectionState = "disconnected"
  private child: ChildProcess | null = null
  private socketPath: string
  private buffer = ""
  private pending = new Map<number, {
    resolve: (r: DaemonResponse) => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
  }>()
  private nextId = 1
  private listener: ReturnType<typeof import("node:net").createConnection> | null = null
  private stream: NodeJS.ReadWriteStream | null = null
  private connectPromise: Promise<void> | null = null
  private helloPromise: Promise<HelloResult> | null = null

  constructor(projectDir: string) {
    this.socketPath = daemonSocketPath(projectDir)
  }

  /** Get current connection state for debugging/monitoring. */
  getState(): DaemonConnectionState {
    return this.state
  }

  /**
   * Spawn the daemon on demand using single-flight startup with an atomic lock.
   * Never spawns per request. Concurrent callers converge on one daemon PID.
   * Never unlinks a live socket or deletes a regular file.
   */
  async ensureStarted(): Promise<void> {
    if (await isDaemonRunning(this.socketPath)) return

    const lock = new StartupLock(this.socketPath)
    try {
      const acquired = await lock.acquire()
      if (!acquired) {
        // Another process is starting the daemon — wait for it.
        const deadline = Date.now() + STARTUP_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (await isDaemonRunning(this.socketPath)) return
          await sleep(50)
        }
        throw new Error("fdxd did not become ready in time (concurrent start)")
      }

      // Re-check after acquiring lock (double-check pattern).
      if (await isDaemonRunning(this.socketPath)) return

      const bin = resolveDaemonBinaryPath()
      if (!bin) throw new Error("fdxd binary not found — install via `bun run build:fdx`")

      // Verify socket path does not point to a regular file.
      const fs = require("node:fs")
      try {
        const stat = fs.statSync(this.socketPath)
        if (stat.isFile()) {
          throw new Error(`refusing to overwrite regular file at socket path: ${this.socketPath}`)
        }
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e
        // ENOENT is expected — socket does not exist yet.
      }

      this.child = spawn(bin, ["--socket", this.socketPath, "--idle", String(DAEMON_IDLE_SECONDS)], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: false,
      })
      this.child.stderr?.on("data", (d: Buffer) => {
        this.lastStderr = d.toString().slice(0, 2000)
      })

      // Wait for the socket to appear + accept.
      const deadline = Date.now() + STARTUP_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (this.child.exitCode !== null) {
          throw new Error(`fdxd exited during startup (code ${this.child.exitCode}): ${this.lastStderr}`)
        }
        if (await isDaemonRunning(this.socketPath)) return
        await sleep(50)
      }
      throw new Error("fdxd did not become ready in time")
    } finally {
      lock.release()
    }
  }

  private lastStderr = ""

  /** Idempotent connection establishment. Returns existing connection if ready. */
  async connect(): Promise<void> {
    if (this.state === "ready") return
    if (this.state === "connecting" || this.state === "handshaking") {
      if (!this.connectPromise) {
        this.connectPromise = this.doConnect()
      }
      return await this.connectPromise
    }

    this.state = "connecting"
    this.connectPromise = this.doConnect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async doConnect(): Promise<void> {
    const net = require("node:net") as typeof import("node:net")
    this.listener = net.createConnection(this.socketPath)
    this.listener.setNoDelay(true)
    this.stream = this.listener

    this.listener.on("data", (d: Buffer) => this.onData(d))
    this.listener.on("error", (e: Error) => this.onDisconnect(e))
    this.listener.on("close", () => this.onDisconnect(new Error("daemon connection closed")))

    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon connect timeout")), HANDSHAKE_TIMEOUT_MS)
      this.listener!.once("connect", () => {
        clearTimeout(timer)
        this.state = "handshaking"
        resolvePromise()
      })
      this.listener!.once("error", (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  /** Perform hello handshake once per connection. */
  async hello(client: string, clientVersion: string): Promise<HelloResult> {
    if (this.state !== "handshaking" && this.state !== "ready") {
      throw new Error(`Cannot perform hello: invalid state ${this.state}`)
    }

    if (!this.helloPromise) {
      this.helloPromise = this.doHello(client, clientVersion)
    }
    try {
      const hello = await this.helloPromise
      this.state = "ready"
      return hello
    } finally {
      this.helloPromise = null
    }
  }

  private async doHello(client: string, clientVersion: string): Promise<HelloResult> {
    const resp = await this.request("hello", {
      client,
      clientVersion,
    }, HANDSHAKE_TIMEOUT_MS)
    if (!resp.ok || !resp.result) {
      throw new Error(`daemon hello failed: ${resp.error?.message || "no result"}`)
    }
    const hello = resp.result as HelloResult
    if (hello.capabilities.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `daemon protocol mismatch: client v${PROTOCOL_VERSION} vs daemon v${hello.capabilities.protocol}`,
      )
    }
    return hello
  }

  /** Graceful shutdown of the daemon. */
  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", undefined, 2_000)
    } catch {
      // best-effort
    }
    await this.close()
  }

  /** Close the client side; does NOT kill a daemon we did not spawn. */
  async close(): Promise<void> {
    this.state = "closing"
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error("daemon connection closed"))
    }
    this.pending.clear()
    if (this.listener) {
      this.listener.destroy()
      this.listener = null
    }
    this.stream = null
    this.state = "disconnected"
    // Clean up any orphaned lock file for this socket.
    try {
      const fs = require("node:fs")
      fs.unlinkSync(this.socketPath + ".lock")
    } catch {
      // Ignore — lock may not exist or may be held by another process.
    }
  }

  /** Stop a daemon this client spawned (used by tests for cleanup). */
  async killSpawned(): Promise<void> {
    if (this.child) {
      this.child.kill()
      await sleep(100)
      if (this.child.exitCode === null) this.child.kill("SIGKILL")
      this.child = null
    }
  }

  /** Request cancellation of an in-flight request id. */
  async cancel(targetId: number): Promise<DaemonResponse> {
    return this.request("cancel", { targetId }, DEFAULT_TIMEOUT_MS)
  }

  /** Execute a single hosted command. */
  async query(command: string, argv: string[], cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonResponse> {
    return this.request("query", { command, argv, cwd }, timeoutMs)
  }

  /** Execute a typed read-only batch (Task 4). Responses in input order. */
  async batch(
    operations: BatchOperation[],
    cwd?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<DaemonResponse> {
    return this.request(
      "batch",
      { version: 1, operations, cwd },
      timeoutMs,
    )
  }

  /** Fetch capability metadata for all hosted tools. */
  async capabilities(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonResponse> {
    return this.query("capabilities.query", [], undefined, timeoutMs)
  }

  /** Ping liveness probe. */
  async ping(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonResponse> {
    return this.request("ping", undefined, timeoutMs)
  }

  /** Send a correlated request and await its response. */
  request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<DaemonResponse> {
    if (this.state !== "ready" && this.state !== "handshaking") {
      return Promise.reject(new Error(`Cannot send request: invalid state ${this.state}`))
    }
    const id = this.nextId++
    const body: DaemonRequest = { v: PROTOCOL_VERSION, id, method }
    if (params !== undefined) body.params = params
    return new Promise<DaemonResponse>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`daemon request ${id} (${method}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      const line = JSON.stringify(body) + "\n"
      this.stream!.write(line)
    })
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString("utf-8")
    if (this.buffer.length > MAX_OUTPUT_BYTES * 2) {
      // Bounded: drop the overflow and error all pending requests.
      this.buffer = ""
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error("daemon response stream exceeded bound"))
      }
      this.pending.clear()
      return
    }
    let idx: number
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      this.onMessage(line)
    }
  }

  private onMessage(line: string): void {
    let msg: DaemonResponse
    try {
      msg = JSON.parse(line) as DaemonResponse
    } catch {
      return // malformed line: ignore (server-side validation catches its own)
    }
    if (msg.id === null || msg.id === undefined) return // server event, not correlated
    const entry = this.pending.get(msg.id)
    if (!entry) return // unknown/stale id
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    entry.resolve(msg)
  }

  private onDisconnect(e: Error): void {
    this.state = "failed"
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`daemon disconnected: ${e.message}`))
    }
    this.pending.clear()
  }
}

// ─── High-level client with fallback ladder ─────────────────────────────────

export interface DaemonRegistry {
  /** Get or create a daemon connection for a project directory. */
  get(projectDir: string): DaemonConnection

  /** Disconnect a specific client connection. */
  disconnect(projectDir: string): Promise<void>

  /** Shutdown a daemon owned by this client (used by tests). */
  shutdownOwned(projectDir: string): Promise<void>

  /** Reset all test connections (for test isolation). */
  resetAll(): Promise<void>

  /** Clear all cached connections and fallback state. */
  clearCache(): void
}

/** Global daemon registry for managing connections across projects. */
export class DaemonRegistryImpl implements DaemonRegistry {
  private connections = new Map<string, DaemonConnection>()
  private fallbackState = {
    lastReason: "ok" as FallbackReason,
    lastDetail: undefined as string | undefined,
  }

  get(projectDir: string): DaemonConnection {
    const key = resolve(projectDir)
    if (!this.connections.has(key)) {
      this.connections.set(key, new DaemonConnection(projectDir))
    }
    return this.connections.get(key)!
  }

  async disconnect(projectDir: string): Promise<void> {
    const key = resolve(projectDir)
    const conn = this.connections.get(key)
    if (conn) {
      await conn.close()
      this.connections.delete(key)
    }
  }

  async shutdownOwned(projectDir: string): Promise<void> {
    const key = resolve(projectDir)
    const conn = this.connections.get(key)
    if (conn) {
      await conn.killSpawned()
      this.connections.delete(key)
    }
  }

  async resetAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [, conn] of this.connections) {
      promises.push(conn.close())
    }
    await Promise.all(promises)
    this.connections.clear()
    this.fallbackState.lastReason = "ok"
    this.fallbackState.lastDetail = undefined
  }

  clearCache(): void {
    this.connections.clear()
    this.fallbackState.lastReason = "ok"
    this.fallbackState.lastDetail = undefined
  }

  getFallbackState() {
    return { ...this.fallbackState }
  }

  /** Set the current fallback state (mutates in place). */
  setFallback(reason: FallbackReason, detail?: string): void {
    this.fallbackState.lastReason = reason
    this.fallbackState.lastDetail = detail
  }
}

/** Global daemon registry instance. */
export const daemonRegistry = new DaemonRegistryImpl()

/** Disconnect a specific client connection. */
export async function disconnectDaemonConnection(projectDir: string): Promise<void> {
  await daemonRegistry.disconnect(projectDir)
}

/** Shutdown a daemon owned by this client (used by tests for cleanup). */
export async function shutdownOwnedDaemon(projectDir: string): Promise<void> {
  await daemonRegistry.shutdownOwned(projectDir)
}

/** Reset all daemon connections and fallback state (for test isolation). */
export async function resetDaemonConnection(): Promise<void> {
  await daemonRegistry.resetAll()
}

/** Clear all cached connections and fallback state. */
export function clearDaemonCache(): void {
  daemonRegistry.clearCache()
}

/** Get the last fallback reason (backward-compatible). */
export function getLastFallbackReason(): FallbackReason {
  return daemonRegistry.getFallbackState().lastReason
}

/** Get the last fallback detail (backward-compatible). */
export function getLastFallbackDetail(): string | undefined {
  return daemonRegistry.getFallbackState().lastDetail
}

/**
 * Execute a command through the daemon when possible, falling back to the
 * current one-shot native fdx spawn, then the TS fallbacks. No infinite
 * daemon-start loops: a single startup attempt per request at most.
 */
export async function runViaDaemon(
  projectDir: string,
  command: string,
  argv: string[],
  opts: {
    client?: string
    clientVersion?: string
    cwd?: string
    timeoutMs?: number
    allowTsFallback?: boolean
  } = {},
): Promise<ClientResult<string>> {
  const started = Date.now()
  const client = daemonRegistry.get(projectDir)

  // 1. Try the daemon path (single startup attempt; no loop).
  try {
    await client.ensureStarted()
    await client.connect()
    await client.hello(opts.client || "flowdeck", opts.clientVersion || "0.0.0")
    const resp = await client.query(command, argv, opts.cwd, opts.timeoutMs || DEFAULT_TIMEOUT_MS)
    if (!resp.ok) {
      if (resp.error?.code === "E_UNSUPPORTED") {
        daemonRegistry.setFallback("command-not-hosted", resp.error.message)
        return fallbackToOneShot(command, argv, opts, started)
      }
      daemonRegistry.setFallback("daemon-unavailable", resp.error?.message)
      return fallbackToOneShot(command, argv, opts, started)
    }
    daemonRegistry.setFallback("ok")
    return {
      value: (resp.result as QueryResult | undefined)?.stdout ?? JSON.stringify(resp.result ?? null),
      fallback: "ok",
      metrics: {
        transport: "daemon",
        durationMs: Date.now() - started,
        daemonPid: undefined,
        cached: (resp.result as QueryResult | undefined)?.cached,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const reason: FallbackReason = msg.includes("protocol mismatch")
      ? "daemon-incompatible"
      : msg.includes("timed out")
        ? "daemon-timeout"
        : msg.includes("did not become ready") || msg.includes("during startup")
          ? "daemon-not-ready"
          : "daemon-unavailable"
    daemonRegistry.setFallback(reason, msg)
    await client.close().catch(() => undefined)
    return fallbackToOneShot(command, argv, opts, started)
  }
}

/** One-shot native fdx spawn (current behaviour), then TS fallback. */
function fallbackToOneShot(
  command: string,
  argv: string[],
  opts: { cwd?: string; allowTsFallback?: boolean; timeoutMs?: number },
  started: number,
): ClientResult<string> {
  if (shouldDisableFallback()) {
    daemonRegistry.setFallback("disabled")
    return {
      fallback: "disabled",
      reason: daemonRegistry.getFallbackState().lastDetail,
      metrics: { transport: "one-shot", durationMs: Date.now() - started },
    }
  }
  try {
    const out = runFdx([command, ...argv])
    daemonRegistry.setFallback("ok")
    return {
      value: out,
      fallback: "ok",
      metrics: { transport: "one-shot", durationMs: Date.now() - started },
    }
  } catch (e) {
    if (opts.allowTsFallback === false || !resolveFdxBinaryPath()) {
      daemonRegistry.setFallback("native-unavailable", e instanceof Error ? e.message : String(e))
      return {
        fallback: "native-unavailable",
        reason: e instanceof Error ? e.message : String(e),
        metrics: { transport: "one-shot", durationMs: Date.now() - started },
      }
    }
    const ts = tsFallback(command, argv)
    if (ts !== null) {
      daemonRegistry.setFallback("ok")
      return {
        value: ts,
        fallback: "ok",
        metrics: { transport: "ts-fallback", durationMs: Date.now() - started },
      }
    }
    daemonRegistry.setFallback("native-unavailable", e instanceof Error ? e.message : String(e))
    return {
      fallback: "native-unavailable",
      reason: e instanceof Error ? e.message : String(e),
      metrics: { transport: "one-shot", durationMs: Date.now() - started },
    }
  }
}

/** TS in-process fallbacks for a small known command surface. */
function tsFallback(command: string, argv: string[]): string | null {
  try {
    switch (command) {
      case "read":
        return nativeReadFallback(argv[0] || ".", parseNum(argv, "--limit"), parseNum(argv, "--offset"))
      case "search":
        return nativeSearchFallback(argv[0] || "", argv[1] || ".")
      case "ls":
        return nativeLsFallback(argv[0] || ".")
      case "outline":
        return nativeOutlineFallback(argv.length ? argv : ["."])
      case "git":
        return nativeGitFallback(argv)
      default:
        return null
    }
  } catch {
    return null
  }
}

function parseNum(argv: string[], flag: string): number | undefined {
  const i = argv.indexOf(flag)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
