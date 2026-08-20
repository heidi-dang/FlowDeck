/**
 * FlowDeck Orchestration Database Path Resolver
 *
 * Deterministic writable orchestration database selection.
 * Preferred: <directory>/.flowdeck/flowdeck.db
 * Fallbacks: ~/.flowdeck/flowdeck.db -> <tmpdir>/flowdeck/flowdeck.db
 */

import { mkdirSync, writeFileSync, rmSync } from "fs"
import { dirname, join } from "path"
import { homedir, tmpdir } from "os"

export function resolveOrchestrationDbPath(
  directory: string,
  log?: (msg: string, level?: "debug" | "info" | "warn" | "error") => Promise<void>,
): string {
  const candidates = [
    join(directory, ".flowdeck", "flowdeck.db"),
    join(homedir(), ".flowdeck", "flowdeck.db"),
    join(tmpdir(), "flowdeck", "flowdeck.db"),
  ]
  for (const candidate of candidates) {
    const dir = dirname(candidate)
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.flowdeck-probe-${process.pid}`)
      writeFileSync(probe, "writable")
      rmSync(probe, { force: true })
    } catch (err) {
      if (log) {
        void log(`[orchestration] database directory not writable: ${dir} (${err instanceof Error ? err.message : String(err)})`, "warn")
      }
      continue
    }
    return candidate
  }
  // All candidates unwritable: return the project path and let initializeDatabase
  // raise the real underlying error — do not hide it.
  return candidates[0]
}
