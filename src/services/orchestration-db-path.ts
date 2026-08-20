/**
 * FlowDeck Orchestration Database Path Resolver
 *
 * Deterministic writable orchestration database selection.
 * Preferred: <directory>/.flowdeck/flowdeck.db
 * Fallbacks: ~/.flowdeck/flowdeck.db -> <tmpdir>/flowdeck/flowdeck.db
 *
 * Split-brain protection:
 * - If the preferred database already exists on disk, we NEVER silently fall back
 *   to creating a secondary DB elsewhere. A secondary DB would split orchestration
 *   state, events, and task runs across multiple independent databases.
 * - If the preferred DB exists and is not writable, we raise an explicit error.
 * - Fallbacks are ONLY used when bootstrapping in an unwritable root (e.g. "/" or read-only volume)
 *   where NO database exists yet.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, accessSync, constants } from "fs"
import { dirname, join } from "path"
import { homedir, tmpdir } from "os"

export class OrchestrationDatabaseInaccessibleError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`ORCHESTRATION_DATABASE_INACCESSIBLE: Existing database at "${path}" cannot be accessed: ${reason}. Automatic fallback is blocked to prevent database split-brain.`)
    this.name = "OrchestrationDatabaseInaccessibleError"
  }
}

export function resolveOrchestrationDbPath(
  directory: string,
  log?: (msg: string, level?: "debug" | "info" | "warn" | "error") => Promise<void>,
): string {
  const preferredPath = join(directory, ".flowdeck", "flowdeck.db")

  // Split-brain guard: If the project database file already exists, verify its accessibility directly.
  // Never silently fall back and create a phantom state database in ~/.flowdeck or tmpdir.
  if (existsSync(preferredPath)) {
    try {
      accessSync(preferredPath, constants.R_OK | constants.W_OK)
      return preferredPath
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (log) {
        void log(`[orchestration] preferred database exists but is not writable: ${preferredPath} (${errMsg})`, "error")
      }
      throw new OrchestrationDatabaseInaccessibleError(preferredPath, errMsg)
    }
  }

  const candidates = [
    preferredPath,
    join(homedir(), ".flowdeck", "flowdeck.db"),
    join(tmpdir(), "flowdeck", "flowdeck.db"),
  ]

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const dir = dirname(candidate)
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.flowdeck-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      writeFileSync(probe, "writable")
      rmSync(probe, { force: true })
    } catch (err) {
      if (log) {
        void log(`[orchestration] database directory not writable: ${dir} (${err instanceof Error ? err.message : String(err)})`, "warn")
      }
      continue
    }

    if (i > 0 && log) {
      void log(`[orchestration] using fallback database location: ${candidate} (preferred ${preferredPath} directory unwritable)`, "info")
    }
    return candidate
  }

  // All candidates unwritable: return the preferred path and let initializeDatabase
  // raise the real underlying error.
  return candidates[0]
}
