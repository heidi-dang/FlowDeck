import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { basename, dirname, join } from "path"
import { homedir, tmpdir } from "os"
import { statePath, parseState, planningDir, checkpointPath } from "../tools/planning-state-lib"

const LOG_DIR = ".opencode"
const LOG_FILE = "flowdeck.log"

/** Cache of resolved writable log paths keyed by normalized directory */
const logPathCache = new Map<string, string>()

/** Track whether all destinations failure diagnostic was emitted (at most once) */
let allDestinationsFailedLogged = false

/**
 * Reset internal cache and diagnostic state (useful for tests).
 */
export function _resetSessionEventsState(): void {
  logPathCache.clear()
  allDestinationsFailedLogged = false
}

/**
 * Probes whether a target log directory can be created and written to.
 * Creates parent recursively if permitted, tests write capability with a probe file,
 * cleans up the probe immediately, and catches all filesystem exceptions.
 */
function probeWritableDirectory(dirPath: string): boolean {
  try {
    mkdirSync(dirPath, { recursive: true })
    const probePath = join(dirPath, `.flowdeck-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(probePath, "probe", "utf-8")
    rmSync(probePath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Helper to determine if a directory path represents a filesystem root
 * (e.g. "/", "\", "C:\", "d:/", etc.) where creating /.opencode is prohibited.
 */
function isFileSystemRoot(directory: string): boolean {
  if (!directory || typeof directory !== "string") return false
  const trimmed = directory.trim()
  if (trimmed === "/" || trimmed === "\\") return true
  // Windows drive root (e.g., C:, C:\, C:/)
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return true
  return false
}

/**
 * Resolves candidate directory locations for session log persistence in priority order:
 * 1. Project-local: <project>/.opencode/flowdeck.log (skipped if project is filesystem root)
 * 2. User state:
 *    - Windows: %LOCALAPPDATA%/flowdeck or %APPDATA%/flowdeck or ~/.local/state/flowdeck
 *    - Linux/macOS: $XDG_STATE_HOME/flowdeck or ~/.local/state/flowdeck
 * 3. System temp: <tmpdir>/flowdeck/flowdeck.log
 */
export function getCandidateLogPaths(directory: string): string[] {
  const candidates: string[] = []

  // 1. Preferred location: project-local (never attempt root-level .opencode)
  if (directory && typeof directory === "string" && !isFileSystemRoot(directory)) {
    candidates.push(join(directory, LOG_DIR, LOG_FILE))
  }

  // 2. User-state fallback
  const isWindows = process.platform === "win32"
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
    if (localAppData) {
      candidates.push(join(localAppData, "flowdeck", LOG_FILE))
    } else {
      candidates.push(join(homedir(), ".local", "state", "flowdeck", LOG_FILE))
    }
  } else {
    const xdgStateHome = process.env.XDG_STATE_HOME
    if (xdgStateHome && xdgStateHome.trim()) {
      candidates.push(join(xdgStateHome, "flowdeck", LOG_FILE))
    } else {
      candidates.push(join(homedir(), ".local", "state", "flowdeck", LOG_FILE))
    }
  }

  // 3. System temp fallback
  candidates.push(join(tmpdir(), "flowdeck", LOG_FILE))

  return candidates
}

/**
 * Resolves a writable session log path from candidate locations.
 * Uses caching to avoid repeated filesystem probes across events.
 */
export function resolveSessionLogPath(directory: string): string | null {
  const cached = logPathCache.get(directory)
  if (cached) {
    return cached
  }

  const candidates = getCandidateLogPaths(directory)
  for (const candidate of candidates) {
    const candidateDir = dirname(candidate)
    if (probeWritableDirectory(candidateDir)) {
      logPathCache.set(directory, candidate)
      return candidate
    }
  }

  return null
}

/**
 * Get structured event detail message for known event types.
 */
function getEventDetail(eventType: "idle" | "error" | "completed" | string): string {
  switch (eventType) {
    case "idle":
      return "Session is idle. State checkpointed — resume with /fd-resume."
    case "error":
      return "Session encountered an error."
    case "completed":
      return "Session completed."
    default:
      return `Session event: ${eventType}`
  }
}

/**
 * HOOK-02: Idle, error, and completion session notifications.
 * Writes JSON Lines entries to a writable flowdeck.log (project-local with safe user-state / temp fallbacks),
 * and on idle refreshes `~/.fd-plan/<slug>/checkpoint.json` so an interrupted session stays resumable.
 *
 * Failure to create a log directory or append entries is non-fatal and must never crash or destabilize the session.
 */
export async function sessionEventsHook(
  ctx: { directory: string },
  eventType: "idle" | "error" | "completed",
  _sessionID: string,
): Promise<void> {
  if (eventType === "idle") {
    saveCheckpoint(ctx.directory)
  }

  const phase = getPhase(ctx.directory)
  const timestamp = new Date().toISOString()
  const detail = getEventDetail(eventType)
  const entry = { timestamp, event: eventType, phase, detail }
  const line = JSON.stringify(entry) + "\n"

  try {
    let resolvedPath = resolveSessionLogPath(ctx.directory)
    if (resolvedPath) {
      try {
        appendFileSync(resolvedPath, line, "utf-8")
        return
      } catch {
        // Append failed after path resolution (e.g. disk full, permissions revoked)
        // Invalidate cache and retry through candidates
        logPathCache.delete(ctx.directory)
        const candidates = getCandidateLogPaths(ctx.directory)
        for (const candidate of candidates) {
          if (candidate === resolvedPath) continue
          const candidateDir = dirname(candidate)
          if (probeWritableDirectory(candidateDir)) {
            try {
              appendFileSync(candidate, line, "utf-8")
              logPathCache.set(ctx.directory, candidate)
              return
            } catch {
              continue
            }
          }
        }
      }
    }

    // If all destinations failed or no writable path resolved
    if (!allDestinationsFailedLogged) {
      allDestinationsFailedLogged = true
      console.warn("[flowdeck] Warning: Session log persistence failed for all candidate destinations; continuing session operation.")
    }
  } catch {
    // Non-fatal safety guard: hook must never throw
  }
}

/**
 * Refresh `checkpoint.json` on idle.
 *
 * Commands write the meaningful fields (`current_command`, `current_stage`,
 * `phases`, …) as they run. This only stamps `saved_at` and re-persists whatever
 * the agent last wrote, so a session that dies between commands stays resumable.
 *
 * Never throws — a failed checkpoint must not break the idle event.
 */
function saveCheckpoint(directory: string): void {
  const slug = basename(directory)
  const planDir = planningDir(directory)
  const filePath = checkpointPath(directory)

  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
  } catch {
    // No checkpoint yet, or it is unreadable — start from an empty base.
  }

  const checkpoint = {
    ...existing,
    version: "1",
    project: slug,
    saved_at: new Date().toISOString(),
  }

  try {
    if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8")
  } catch {
    // Checkpointing is best-effort; the idle log entry below still records the event.
  }
}

/**
 * Read current phase from STATE.md. Returns null if unreadable.
 */
function getPhase(directory: string): string | null {
  try {
    const stateFilePath = statePath(directory)
    const content = readFileSync(stateFilePath, "utf-8")
    const state = parseState(content)
    const currentPhase = (state["current_phase"] || {}) as Record<string, unknown>
    return (currentPhase["phase"] as string) ?? null
  } catch {
    return null
  }
}
