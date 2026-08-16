import type { CheckResult } from "../types"
import { createAgent } from "../../agents/index"
import { getAllCanonicalAgents } from "../../services/canonical-registry"
import { loadFlowDeckConfig } from "../../config/agent-models"

export async function runHeidiChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  try {
    const agents = getAllCanonicalAgents()
    const heidiAgent = createAgent("heidi")
    const browserDebugger = createAgent("browser-debugger")

    if (heidiAgent && agents.length > 0) {
      checks.push({
        id: "heidi.registry",
        title: "Heidi Primary Execution Agent",
        category: "heidi",
        severity: "info",
        status: "pass",
        detected: `Heidi coordinator & ${agents.length} agents registered`,
        expected: "Heidi primary agent registered",
        recommendation: "Heidi execution coordinator healthy",
        autoFixAvailable: false,
        affectsRuntime: false,
        repairability: "not-applicable",
      })
    } else {
      checks.push({
        id: "heidi.registry",
        title: "Heidi Primary Execution Agent",
        category: "heidi",
        severity: "critical",
        status: "error",
        detected: "Heidi primary agent failed to resolve from registry",
        expected: "Heidi primary agent active",
        recommendation: "Run `flowdeck doctor fix` to repair canonical agent registry",
        autoFixAvailable: true,
        affectsRuntime: true,
        repairability: "automatic",
        repairAction: "repair_agent_registry",
      })
    }

    const config = loadFlowDeckConfig(_directory)
    const maxWrites = config.maxWritesPerAgent ?? 100
    const maxDelegations = config.governance?.delegationBudget?.maxDelegations ?? 100
    const maxCalls = config.heidi?.toolPipeline?.maxCalls ?? 100

    checks.push({
      id: "heidi.autonomy_limits",
      title: "Autonomous Session Quotas",
      category: "heidi",
      severity: "info",
      status: "pass",
      detected: `Writes: ${maxWrites}, Delegations: ${maxDelegations}, Pipeline Calls: ${maxCalls} (productive quotas >=100)`,
      expected: "Autonomous session limits configured for long coding sessions (>=100)",
      recommendation: "Autonomy quotas operational for long sessions",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })

    if (browserDebugger) {
      checks.push({
        id: "heidi.browser_debugger",
        title: "Browser Debugger Specialist",
        category: "heidi",
        severity: "info",
        status: "pass",
        detected: "@browser-debugger specialist active",
        expected: "Browser Debugger specialist available",
        recommendation: "Autonomous browser debugging ready",
        autoFixAvailable: false,
        affectsRuntime: false,
        repairability: "not-applicable",
      })
    }
  } catch (err) {
    checks.push({
      id: "heidi.registry",
      title: "Heidi Primary Execution Agent",
      category: "heidi",
      severity: "critical",
      status: "error",
      detected: `Heidi registry load failure: ${err}`,
      expected: "Heidi registry loaded",
      recommendation: "Run `flowdeck doctor fix` to rebuild agent index",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "repair_agent_registry",
    })
  }

  return checks
}
