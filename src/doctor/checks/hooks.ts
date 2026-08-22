import type { CheckResult } from "../types"
import { loadFlowDeckConfig } from "../../config/agent-models"

const HOOKS = [
  { name: "chat.message", classification: "mandatory" as const, description: "Runtime agent identity enforcement" },
  { name: "tool.execute.before", classification: "mandatory" as const, description: "Tool permission and governance" },
  { name: "tool.execute.after", classification: "mandatory" as const, description: "Post-write verification and audit" },
  { name: "guardRailsHook", classification: "mandatory" as const, description: "Build/deploy guard" },
  { name: "orchestratorGuard", classification: "mandatory" as const, description: "Agent tool permissions" },
  { name: "toolGuardHook", classification: "mandatory" as const, description: "Write limits, dangerous ops" },
  { name: "sessionStartHook", classification: "mandatory" as const, description: "Session initialisation" },
  { name: "sessionEventsHook", classification: "mandatory" as const, description: "Session state persistence" },
  { name: "commandRefGuard", classification: "recommended" as const, description: "Command formatting validation" },
  { name: "patchTrust", classification: "recommended" as const, description: "Patch trust scoring" },
  { name: "notifications", classification: "optional" as const, description: "Desktop notifications" },
  { name: "todoHook", classification: "recommended" as const, description: "Task tracking" },
  { name: "fileTracker", classification: "recommended" as const, description: "File change tracking" },
  { name: "contextWindowMonitor", classification: "recommended" as const, description: "Token budget monitoring" },
]

export async function runHookChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const config = loadFlowDeckConfig(directory)

  for (const hook of HOOKS) {
    let isActive = true
    let statusDetail = "Active and verified"

    if (hook.name === "guardRailsHook" && process.env.FLOWDECK_GUARD_RAILS_ENABLED === "0") {
      isActive = false
      statusDetail = "Disabled by FLOWDECK_GUARD_RAILS_ENABLED=0"
    } else if (hook.name === "chat.message" && config.runtimeAgent?.enforcement === "off") {
      isActive = false
      statusDetail = "Disabled by runtimeAgent.enforcement=off"
    }

    const status: "pass" | "warning" | "info" | "error" = isActive
      ? "pass"
      : hook.classification === "mandatory"
      ? "warning"
      : "info"

    checks.push({
      id: `hook.${hook.name}`,
      title: `Hook: ${hook.name}`,
      category: "hook",
      severity: hook.classification === "mandatory" ? "high" : hook.classification === "recommended" ? "medium" : "low",
      status,
      detected: `${statusDetail} (${hook.classification})`,
      expected: hook.classification === "mandatory" ? "Active and critical" : "Available when needed",
      recommendation: isActive ? "OK" : `Enable ${hook.name} in FlowDeck configuration for ${hook.description}`,
      autoFixAvailable: false,
    })
  }

  return checks
}
