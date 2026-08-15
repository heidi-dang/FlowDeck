import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { AutoFixResult } from "../../types"

export async function repairPluginRegistration(_directory: string): Promise<AutoFixResult> {
  const PKG_NAME = "@heidi-dang/flowdeck"
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))

  const configFile = join(configDir, "opencode.json")

  try {
    let cfg: any = { plugin: [] }
    if (existsSync(configFile)) {
      try {
        cfg = JSON.parse(readFileSync(configFile, "utf-8"))
      } catch {
        cfg = { plugin: [] }
      }
    }

    if (!Array.isArray(cfg.plugin)) {
      cfg.plugin = []
    }

    // Filter legacy upstream refs and duplicate refs
    const filtered = cfg.plugin.filter((p: string) => p !== "@dv.nghiem/flowdeck" && p !== PKG_NAME)
    filtered.push(PKG_NAME)
    cfg.plugin = Array.from(new Set(filtered))

    // Set default_agent if missing
    if (!cfg.default_agent) {
      cfg.default_agent = "heidi"
    }

    mkdirSync(dirname(configFile), { recursive: true })
    writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8")

    return {
      id: "plugin.registration",
      description: "Repaired FlowDeck plugin registration in opencode.json",
      applied: true,
      reverified: true,
    }
  } catch (err: any) {
    return {
      id: "plugin.registration",
      description: "Plugin registration repair failed",
      applied: false,
      error: err.message,
    }
  }
}
