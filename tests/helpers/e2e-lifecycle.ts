/**
 * E2E lifecycle helpers — bounded server readiness, bounded browser launch,
 * guaranteed process-tree cleanup, and orphan-process detection.
 *
 * The Windows regression this guards: the real browser E2E suite hung until
 * the global 60s timeout because (a) nothing bounded server readiness, browser
 * launch, or close, and (b) persistent SSE connections could block
 * `server.close()` forever. Every await here is bounded and every failure
 * carries the last readiness/close state as a structured message.
 */

import { createServer, type Server, type ServerResponse } from "http"
import { get } from "http"
import type { AddressInfo } from "net"
import { chromium, type Browser, type BrowserContext } from "playwright"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export interface SseManagerLike {
  dispose(): void
}

export interface E2EServer {
  server: Server
  port: number
  /** Human-readable readiness summary, reported on any failure. */
  lastState: () => string
}

/** Start an HTTP server on an ephemeral port and wait until it is ready. */
export async function startE2EServer(
  handler: (
    req: import("http").IncomingMessage,
    res: ServerResponse,
    server: Server,
  ) => void,
  opts: { readinessTimeoutMs?: number; probePath?: string } = {},
): Promise<E2EServer> {
  const { readinessTimeoutMs = 10000, probePath = "/" } = opts
  const server = createServer((req, res) => handler(req, res, server))

  // Mutable state via property access so TS control-flow analysis does not
  // narrow it to `null` (the assignments happen inside event callbacks).
  const state: { startupError: Error | null; ready: boolean } = {
    startupError: null,
    ready: false,
  }
  server.on("error", (err: Error) => {
    state.startupError = err
  })
  server.on("close", () => {
    // Only a pre-readiness close is a startup failure; a close during
    // deliberate shutdown is normal.
    if (!state.ready) {
      state.startupError = new Error("server closed before readiness probe completed")
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError)
      resolve()
    })
  })

  const port = (server.address() as AddressInfo).port
  const lastState = (): string => {
    const err = state.startupError ? `; last server error: ${state.startupError.message}` : ""
    return `server listening on 127.0.0.1:${port}${err}`
  }

  // Bounded readiness probe. Fails immediately if the server dies first.
  const deadline = Date.now() + readinessTimeoutMs
  let lastProbe: string | null = null
  while (Date.now() < deadline) {
    if (state.startupError) {
      throw new Error(`E2E server exited before readiness: ${state.startupError.message}`)
    }
    const probe = await probeOnce(port, probePath)
    if (probe.ok) {
      state.ready = true
      return { server, port, lastState }
    }
    lastProbe = probe.detail
    await sleep(50)
  }
  throw new Error(
    `E2E server not ready within ${readinessTimeoutMs}ms (GET ${probePath})${lastProbe ? `; last probe: ${lastProbe}` : ""}`,
  )
}

async function probeOnce(port: number, path: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
      res.resume()
      resolve({ ok: res.statusCode === 200, detail: `status ${res.statusCode}` })
    })
    req.on("timeout", () => {
      req.destroy()
      resolve({ ok: false, detail: "probe timed out" })
    })
    req.on("error", (err) => resolve({ ok: false, detail: err.message }))
  })
}

/** Snapshot of chromium process ids running before launch (for orphan checks). */
export function snapshotChromiumPids(): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"],
        { encoding: "utf-8", windowsHide: true, timeout: 5000 },
      )
      const pids: number[] = []
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/"chrome\.exe","(\d+)"/)
        if (m) pids.push(Number(m[1]))
      }
      return pids
    }
    const out = execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf-8", timeout: 5000 })
    const pids: number[] = []
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+.*(chrom(e|ium))$/)
      if (m) pids.push(Number(m[1]))
    }
    return pids
  } catch {
    return []
  }
}

function killPidTree(pid: number): void {
  if (!pid || pid <= 0) return
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    /* already gone */
  }
}

/** Launch chromium with a hard bound; on timeout, kill any newly spawned
 * chromium processes (best-effort) and throw a structured error. Windows CI
 * runners sometimes need a second attempt (Defender cold-scan, resource
 * contention with parallel workers), so the launch is retried once with the
 * same bound. */
export async function launchBrowserBounded(
  beforePids: number[],
  opts: { launchTimeoutMs?: number; attempts?: number } = {},
): Promise<Browser> {
  const { launchTimeoutMs = 30000, attempts = 2 } = opts
  const launchArgs = ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]
  let lastError: Error | null = null
  const maxAttempts = Math.max(1, attempts)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const launch = chromium.launch({ headless: true, args: launchArgs })
    const timer = sleep(launchTimeoutMs).then(() => {
      throw new Error(`chromium launch attempt ${attempt}/${maxAttempts} timed out after ${launchTimeoutMs}ms`)
    })

    try {
      return await Promise.race([launch, timer])
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Best-effort: kill chromium processes spawned since the snapshot.
      const after = snapshotChromiumPids()
      const spawned = after.filter((pid) => !beforePids.includes(pid))
      for (const pid of spawned) killPidTree(pid)
      if (attempt < maxAttempts) await sleep(250)
    }
  }
  throw new Error(
    `chromium launch failed after ${maxAttempts} attempt(s): ${lastError?.message} (spawned processes killed)`,
  )
}

export interface CloseReport {
  browserClosed: boolean
  serverClosed: boolean
  forceKilled: boolean
}

/** Close browser, context and server with hard bounds; force-kill leftovers. */
export async function closeE2EAll(
  opts: {
    browser?: Browser | null
    context?: BrowserContext | null
    server?: E2EServer | null
    sseManager?: SseManagerLike | null
    browserCloseTimeoutMs?: number
    serverCloseTimeoutMs?: number
  },
): Promise<CloseReport> {
  const { browserCloseTimeoutMs = 10000, serverCloseTimeoutMs = 5000 } = opts
  const report: CloseReport = { browserClosed: false, serverClosed: false, forceKilled: false }
  const browser = opts.browser ?? null
  const context = opts.context ?? null
  const server = opts.server ?? null
  const sseManager = opts.sseManager ?? null

  // 1. End persistent SSE connections so server.close() can complete.
  sseManager?.dispose()

  // 2. Close browser pages/context, then the browser itself — bounded.
  if (browser) {
    try {
      await withTimeout(
        (async () => {
          try {
            await context?.close()
          } catch { /* already closed */ }
          await browser.close()
        })(),
        browserCloseTimeoutMs,
        "browser.close()",
      )
      report.browserClosed = true
    } catch {
      // Force-kill the browser process tree.
      const pid = (browser as unknown as { process?: () => { pid?: number | null } | null })
        .process?.()
        ?.pid
      if (pid) killPidTree(pid)
      try {
        await context?.close()
      } catch { /* ignore */ }
      try {
        await browser.close()
      } catch { /* ignore */ }
      report.forceKilled = true
      report.browserClosed = true
    }
  }

  // 3. Close the HTTP server — bounded; force-destroy lingering sockets.
  if (server) {
    try {
      await withTimeout(closeServerBounded(server.server), serverCloseTimeoutMs, "server.close()")
      report.serverClosed = true
    } catch {
      try {
        server.server.closeAllConnections()
        await withTimeout(
          closeServerBounded(server.server),
          Math.max(1000, serverCloseTimeoutMs / 2),
          "server.close() after closeAllConnections",
        )
        report.serverClosed = true
      } catch {
        server.server.closeAllConnections()
        report.forceKilled = true
      }
    }
  }

  return report
}

function closeServerBounded(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Assert no orphan chromium processes or listening server remain. */
export async function assertNoOrphans(beforePids: number[], port?: number): Promise<void> {
  const now = snapshotChromiumPids()
  const orphans = now.filter((pid) => !beforePids.includes(pid))
  if (orphans.length > 0) {
    throw new Error(`orphan chromium processes remain after cleanup: ${orphans.join(", ")}`)
  }
  if (port !== undefined) {
    const alive = await isPortListening(port)
    if (alive) throw new Error(`E2E server still listening on port ${port}`)
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = get({ host: "127.0.0.1", port, timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
    req.on("error", () => resolve(false))
  })
}

/** Unique temporary working directory, removed on cleanup. */
export function makeWorkDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch { /* best effort */ }
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
