import { execFileSync } from "child_process"
import type { CheckResult } from "../types"

const MCP_SERVERS = [
  { name: "context7", type: "remote", url: "https://mcp.context7.com/mcp", authRequired: false, priority: "recommended" },
  { name: "websearch", type: "remote", url: "https://mcp.exa.ai/mcp", authRequired: true, priority: "optional", authVar: "EXA_API_KEY" },
  { name: "grep_app", type: "remote", url: "https://mcp.grep.app", authRequired: false, priority: "recommended" },
  { name: "github", type: "remote", url: "https://api.githubcopilot.com/mcp/", authRequired: false, priority: "recommended" },
  { name: "memory", type: "local", command: "npx -y @modelcontextprotocol/server-memory", priority: "recommended" },
  { name: "sequentialThinking", type: "local", command: "npx -y @modelcontextprotocol/server-sequential-thinking", priority: "recommended" },
  { name: "magic", type: "local", command: "npx -y @magicuidesign/mcp@latest", priority: "recommended" },
  { name: "playwright", type: "local", command: "npx -y @playwright/mcp --browser chrome", priority: "optional" },
  { name: "tokenOptimizer", type: "local", command: "npx -y token-optimizer-mcp", priority: "recommended" },
  { name: "codegraph", type: "local", command: "codegraph serve --mcp", priority: "optional" },
]

export async function runMCPChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // Check if npx is available (needed for local MCPs)
  let npxAvailable = false
  try {
    execFileSync("npx", ["--version"], {
      encoding: "utf-8",
      timeout: 2000,
      shell: process.platform === "win32",
    })
    npxAvailable = true
  } catch {}

  for (const mcp of MCP_SERVERS) {
    const isDisabled = (process.env.FLOWDECK_DISABLE_MCP || "").split(",").includes(mcp.name)

    if (isDisabled) {
      checks.push({
        id: `mcp.${mcp.name}`,
        title: `MCP: ${mcp.name}`,
        category: "mcp",
        severity: "low",
        status: "skipped",
        detected: "disabled via FLOWDECK_DISABLE_MCP",
        expected: "enabled",
        recommendation: `Enable by removing ${mcp.name} from FLOWDECK_DISABLE_MCP`,
        autoFixAvailable: false,
      })
      continue
    }

    if (mcp.authRequired && mcp.authVar && !process.env[mcp.authVar]) {
      checks.push({
        id: `mcp.${mcp.name}.auth`,
        title: `MCP: ${mcp.name} auth`,
        category: "mcp",
        severity: "low",
        status: "warning",
        detected: `${mcp.authVar} not set`,
        expected: `${mcp.authVar} configured`,
        recommendation: `Set ${mcp.authVar} to enable ${mcp.name} MCP`,
        autoFixAvailable: false,
      })
      continue
    }

    if (mcp.type === "local" && !npxAvailable && !mcp.name.startsWith("codegraph")) {
      checks.push({
        id: `mcp.${mcp.name}`,
        title: `MCP: ${mcp.name}`,
        category: "mcp",
        severity: "medium",
        status: "warning",
        detected: "npx not found",
        expected: `${mcp.command} executable available`,
        recommendation: "Install npx (bundled with npm)",
        autoFixAvailable: false,
      })
      continue
    }

    checks.push({
      id: `mcp.${mcp.name}`,
      title: `MCP: ${mcp.name}`,
      category: "mcp",
      severity: "low",
      status: "pass",
      detected: mcp.type === "remote" ? (mcp.url ?? mcp.command ?? "") : (mcp.command ?? mcp.url ?? ""),
      expected: "configured and available on demand",
      recommendation: `OK — ${mcp.name} is available when called`,
      autoFixAvailable: false,
    })
  }

  return checks
}
