/**
 * FlowDeck Orchestration Database Path Resolver
 *
 * Deterministic writable orchestration database selection.
 * Preferred: <directory>/.flowdeck/flowdeck.db
 * Fallbacks: ~/.flowdeck/flowdeck.db -> <tmpdir>/flowdeck/flowdeck.db
 *
 * Split-brain & ambiguity protection:
 * - Authoritative Preference: If <directory>/.flowdeck/flowdeck.db exists, it is authoritative.
 *   If it is inaccessible, throws OrchestrationDatabaseInaccessibleError rather than silently falling back.
 * - Multiple Existing DBs Ambiguity: If preferred DB does not exist, but multiple candidate fallback
 *   databases exist on disk, throws OrchestrationDatabaseAmbiguityError to prevent silent split-brain.
 * - Single Fallback Adoption: If only one fallback database exists and preferred directory is unwritable,
 *   adopts that fallback database deterministically.
 * - First-ever Startup: If no database exists anywhere, chooses preferred project location if writable,
 *   or first writable fallback candidate.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, accessSync, constants } from "fs"
import { dirname, join } from "path"
import { homedir, tmpdir } from "os"

export class OrchestrationDatabaseInaccessibleError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`ORCHESTRATION_DATABASE_INACCESSIBLE: Authoritative database at "${path}" cannot be accessed: ${reason}. Automatic fallback is blocked to prevent database split-brain.`)
    this.name = "OrchestrationDatabaseInaccessibleError"
  }
}

export class OrchestrationDatabaseAmbiguityError extends Error {
  constructor(public readonly paths: string[]) {
    super(`ORCHESTRATION_DATABASE_AMBIGUITY: Multiple independent databases found across fallback locations (${paths.join(", ")}), but no authoritative project database exists at the target directory. Startup aborted to prevent split-brain state corruption.`)
    this.name = "OrchestrationDatabaseAmbiguityError"
  }
}

export function resolveOrchestrationDbPath(
  directory: string,
  log?: (msg: string, level?: "debug" | "info" | "warn" | "error") => Promise<void>,
): string {
  const preferredPath = join(directory, ".flowdeck", "flowdeck.db")

  // Rule 1 (Authoritative Preference):
  // If the project database exists, it is strictly authoritative.
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

  const fallbackCandidates = [
    join(homedir(), ".flowdeck", "flowdeck.db"),
    join(tmpdir(), "flowdeck", "flowdeck.db"),
  ]

  // Rule 2 (Multiple Fallback Ambiguity Guard):
  // If preferred does not exist, check if multiple fallback databases exist simultaneously.
  const existingFallbacks = fallbackCandidates.filter((p) => existsSync(p))
  if (existingFallbacks.length > 1) {
    if (log) {
      void log(`[orchestration] multiple fallback databases exist: ${existingFallbacks.join(", ")}`, "error")
    }
    throw new OrchestrationDatabaseAmbiguityError(existingFallbacks)
  }

  const candidates = [preferredPath, ...fallbackCandidates]

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

  return candidates[0]
}
