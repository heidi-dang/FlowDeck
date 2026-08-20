import { existsSync, mkdirSync, chmodSync, writeFileSync, rmSync } from "node:fs"
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

    // Post-repair verification: verify directory is writable by writing and removing a temporary file
    const testFile = join(flowdeckDir, `.perm_verify_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`)
    writeFileSync(testFile, "verify", "utf-8")
    rmSync(testFile, { force: true })

    return {
      id: "filesystem.permissions",
      description: "FlowDeck state directory permissions repaired and verified",
      applied: true,
      reverified: true,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "filesystem.permissions",
      description: "FlowDeck state directory permissions repair failed",
      applied: false,
      reverified: false,
      error: message,
    }
  }
}
