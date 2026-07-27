import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { CheckResult } from "../types"

/** Known environment variables used by FlowDeck (values never printed). */
const KNOWN_VARS: Record<string, { required: boolean; description: string }> = {
  NPM_TOKEN: { required: false, description: "npm publish authentication" },
  GITHUB_TOKEN: { required: false, description: "GitHub API authentication" },
  CONTEXT7_API_KEY: { required: false, description: "Context7 MCP authentication" },
  EXA_API_KEY: { required: false, description: "Exa web search MCP authentication" },
  OPENCODE_CONFIG_DIR: { required: false, description: "OpenCode config directory override" },
  OPENCODE_CONFIG: { required: false, description: "OpenCode config file override" },
  XDG_CONFIG_HOME: { required: false, description: "XDG base directory" },
  FLOWDECK_DISABLE_MCP: { required: false, description: "Disable specific MCP servers" },
  FDX_DISABLE_FALLBACK: { required: false, description: "Force native FDX binary" },
  FLOWDECK_GUARD_RAILS_ENABLED: { required: false, description: "Enable/disable guard rails" },
}

export async function runEnvironmentChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // Check each known variable
  for (const [name, info] of Object.entries(KNOWN_VARS)) {
    const isSet = !!process.env[name]
    if (info.required) {
      checks.push({
        id: `env.${name.toLowerCase()}`,
        title: `${name}`,
        category: "environment",
        severity: "high",
        status: isSet ? "pass" : "error",
        detected: isSet ? "[SET]" : "[NOT SET]",
        expected: "Must be configured",
        recommendation: `Set ${name} environment variable`,
        autoFixAvailable: false,
      })
    } else {
      checks.push({
        id: `env.${name.toLowerCase()}`,
        title: `${name}`,
        category: "environment",
        severity: "low",
        status: isSet ? "pass" : "info",
        detected: isSet ? "[SET]" : "[NOT SET]",
        expected: "Optional — set for enhanced functionality",
        recommendation: isSet ? "OK" : `Set ${name} if you need ${info.description}`,
        autoFixAvailable: false,
      })
    }
  }

  // Count unknown vars (heuristic: start with FLOWDECK_)
  const flowdeckVars = Object.keys(process.env).filter(k =>
    k.startsWith("FLOWDECK_") && !KNOWN_VARS[k]
  )
  for (const unknown of flowdeckVars) {
    checks.push({
      id: `env.unknown_${unknown.toLowerCase()}`,
      title: `${unknown} (unknown)`,
      category: "environment",
      severity: "low",
      status: "info",
      detected: "[SET]",
      expected: "Not a recognised FlowDeck variable",
      recommendation: `Remove ${unknown} if unused, or document it`,
      autoFixAvailable: false,
    })
  }

  // OpenCode config directory
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    join(homedir(), ".config", "opencode")
  const configExists = existsSync(configDir)
  checks.push({
    id: "env.opencode_config_dir",
    title: "OpenCode Config Directory",
    category: "environment",
    severity: "medium",
    status: configExists ? "pass" : "info",
    detected: configExists ? configDir : `${configDir} (not found)`,
    expected: "~/.config/opencode/ should exist after installation",
    recommendation: "Run the FlowDeck installer to create OpenCode configuration",
    autoFixAvailable: true,
  })

  return checks
}
