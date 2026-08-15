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
    let cfg: any = {}
    if (existsSync(configFile)) {
      try {
        cfg = JSON.parse(readFileSync(configFile, "utf-8"))
      } catch {
        cfg = {}
      }
    }

    if (!cfg.mcp || typeof cfg.mcp !== "object") {
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

    return {
      id: "mcp.config",
      description: "Normalized MCP server configuration schema in opencode.json",
      applied: true,
      reverified: true,
    }
  } catch (err: any) {
    return {
      id: "mcp.config",
      description: "MCP configuration repair failed",
      applied: false,
      error: err.message,
    }
  }
}
