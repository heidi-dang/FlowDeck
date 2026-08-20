import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { AutoFixResult } from "../../types"

interface McpEntry {
  type: string
  url?: string
  command?: string[]
  enabled?: boolean
  [key: string]: unknown
}

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
          url: "https://mcp.context7.com/mcp",
          enabled: true,
        },
      }
    } else {
      // Validate and normalize existing entries
      const mcpObj = cfg.mcp as Record<string, unknown>
      for (const [key, val] of Object.entries(mcpObj)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) {
          delete mcpObj[key]
        }
      }
      if (Object.keys(mcpObj).length === 0) {
        mcpObj.context7 = {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          enabled: true,
        }
      }
    }

    mkdirSync(dirname(configFile), { recursive: true })
    writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8")

    // Post-repair semantic verification: verify configFile exists, is valid JSON, and has valid MCP server definitions
    let reverified = false
    try {
      const readBack = JSON.parse(readFileSync(configFile, "utf-8"))
      if (readBack && typeof readBack.mcp === "object" && !Array.isArray(readBack.mcp)) {
        const entries = Object.values(readBack.mcp as Record<string, McpEntry>)
        const allValid = entries.length > 0 && entries.every(e => e && typeof e.type === "string" && (e.type === "remote" ? typeof e.url === "string" : Array.isArray(e.command)))
        reverified = allValid
      }
    } catch {
      reverified = false
    }

    return {
      id: "mcp.config",
      description: "Normalized and verified MCP server configuration in opencode.json",
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
