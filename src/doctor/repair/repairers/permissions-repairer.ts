import { existsSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import type { AutoFixResult } from "../../types"

export async function repairPermissions(directory: string): Promise<AutoFixResult> {
  const flowdeckDir = process.env.FLOWDECK_STATE_DIR || join(directory, ".flowdeck")
  try {
    if (!existsSync(flowdeckDir)) {
      mkdirSync(flowdeckDir, { recursive: true })
    }
    if (process.platform !== "win32") {
      chmodSync(flowdeckDir, 0o755)
    }
    return {
      id: "filesystem.permissions",
      description: "FlowDeck state directory permissions repaired",
      applied: true,
      reverified: true,
    }
  } catch (err: any) {
    return {
      id: "filesystem.permissions",
      description: "FlowDeck state directory permissions repair failed",
      applied: false,
      error: err.message,
    }
  }
}
