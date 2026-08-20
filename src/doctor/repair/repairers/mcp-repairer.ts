import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { AutoFixResult } from "../../types"

export async function repairMcpConfiguration(_directory: string): Promise<AutoFixResult> {
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))

  const configFile = join(configDir, "opencode.json")

  try {
    let cfg: Record<string, unknown> = {}
    if (existsSync(configFile)) {
      try {
        const raw = readFileSync(configFile, "utf-8")
        cfg = JSON.parse(raw)
      } catch {
        cfg = {}
      }
    }

    if (!cfg.mcp || typeof cfg.mcp !== "object" || Array.isArray(cfg.mcp)) {
      cfg.mcp = {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/sse",
          enabled: true,
        },
      }
    }

    mkdirSync(dirname(configFile), { recursive: true })
    writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8")

    // Post-repair verification: verify configFile exists and contains valid JSON with mcp object
    let reverified = false
    try {
      const readBack = JSON.parse(readFileSync(configFile, "utf-8"))
      reverified = Boolean(readBack && typeof readBack.mcp === "object" && !Array.isArray(readBack.mcp))
    } catch {
      reverified = false
    }

    return {
      id: "mcp.config",
      description: "Normalized MCP server configuration schema in opencode.json",
      applied: reverified,
      reverified,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "mcp.config",
      description: "MCP configuration repair failed",
      applied: false,
      reverified: false,
      error: message,
    }
  }
}
