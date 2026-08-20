import { existsSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { AutoFixResult } from "../../types"

export async function repairStaleLocks(directory: string): Promise<AutoFixResult> {
  const flowdeckDir = process.env.FLOWDECK_STATE_DIR || join(directory, ".flowdeck")
  const staleLockFiles = [
    join(flowdeckDir, "fdx.lock"),
    join(flowdeckDir, "orchestration.lock"),
    join(flowdeckDir, "browser.lock"),
  ]

  let cleaned = 0
  let unlinkError: string | null = null

  try {
    if (!existsSync(flowdeckDir)) {
      mkdirSync(flowdeckDir, { recursive: true })
    }

    for (const lockFile of staleLockFiles) {
      if (existsSync(lockFile)) {
        try {
          unlinkSync(lockFile)
          cleaned++
        } catch (err: unknown) {
          unlinkError = err instanceof Error ? err.message : String(err)
        }
      }
    }

    // Post-repair verification: ensure state dir exists and no lock files remain
    const stillPresent = staleLockFiles.filter((f) => existsSync(f))
    const reverified = stillPresent.length === 0 && existsSync(flowdeckDir)

    return {
      id: "filesystem.stale_locks",
      description: `Cleaned ${cleaned} stale lock file(s)`,
      applied: reverified && !unlinkError,
      reverified,
      ...(unlinkError ? { error: `Failed to remove some lock files: ${unlinkError}` } : {}),
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "filesystem.stale_locks",
      description: "Stale locks cleanup failed",
      applied: false,
      reverified: false,
      error: message,
    }
  }
}
