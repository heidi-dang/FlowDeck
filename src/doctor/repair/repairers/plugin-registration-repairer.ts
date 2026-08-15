import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import type { AutoFixResult } from "../../types"
import { recordRuntimeSelfReport, getExecutingRuntimeIdentity } from "../../../services/runtime-identity"

export async function repairPluginRegistration(directory: string): Promise<AutoFixResult> {
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

    // Update runtime self report for directory
    const pkgPath = join(directory, "package.json")
    let version = "2.0.1"
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
        version = pkg.version || version
      } catch { /* ignore */ }
    }
    recordRuntimeSelfReport(getExecutingRuntimeIdentity(), directory)

    // Clean stale package cache directories
    const home = homedir()
    const xdgCache = process.env.XDG_CACHE_HOME || join(home, ".cache")
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
    const cacheRoots = [
      join(xdgCache, "opencode", "packages"),
      join(xdgData, "opencode", "packages"),
      join(home, ".cache", "opencode", "packages"),
      join(home, ".local", "share", "opencode", "packages"),
    ]

    const expectedPath = resolve(directory)
    for (const cacheRoot of cacheRoots) {
      if (existsSync(cacheRoot)) {
        try {
          const entries = readdirSync(cacheRoot)
          for (const entry of entries) {
            const fullPath = join(cacheRoot, entry)
            if (resolve(fullPath) === expectedPath) continue
            if (entry.toLowerCase().includes("flowdeck")) {
              rmSync(fullPath, { recursive: true, force: true })
            }
          }
        } catch { /* ignore */ }
      }
    }

    return {
      id: "plugin.registration",
      description: "Repaired FlowDeck plugin registration and synchronized runtime identity",
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
