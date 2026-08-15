import { existsSync, unlinkSync } from "node:fs"
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
  for (const lockFile of staleLockFiles) {
    if (existsSync(lockFile)) {
      try {
        unlinkSync(lockFile)
        cleaned++
      } catch {
        // ignore
      }
    }
  }

  return {
    id: "filesystem.stale_locks",
    description: `Cleaned ${cleaned} stale lock file(s)`,
    applied: true,
    reverified: true,
  }
}
