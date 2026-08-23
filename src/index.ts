import type { Plugin } from "@opencode-ai/plugin"

import { getAgentConfigs } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels } from "./config/index"

import { invalidateFdxCache } from "./tools/fdx-shared"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"

import { join } from "node:path"
import { initializeDatabase } from "./orchestration/persistence"
import { createProductionOrchestrationRuntime, type ProductionOrchestrationRuntime } from "./orchestration/composition"
import { FlowDeckLifecycleAdapter } from "./runtime/flowdeck-opencode-adapter"
import { doctorTool } from "./tools/doctor"
import { fdxValidateTool } from "./tools/fdx-validate"
import { fdxWorktreeTool } from "./tools/fdx-worktree"
import {
  fdxBatchTool,
  fdxContextTool,
  fdxDecisionsTool,
  fdxImpactTool,
  fdxOutlineTool,
  configureFdxNextRuntime,
  setActiveProjectDir,
} from "./tools/fdx"
import { fdxPrMonitorTool } from "./tools/fdx-pr-monitor"
import { codegraphTool } from "./tools/codegraph-tool"

import { debugLogsTool } from "./tools/debug-logs"
import { heidiMemoryTool, heidiRecallTool } from "./tools/heidi-memory"
import { heidiArchiveSessionTool } from "./tools/heidi-session"
import { heidiLearningTool, heidiSkillTool } from "./tools/heidi-learning"
import { heidiAgentsTool } from "./tools/heidi-agents"

// Minimal exports required by tests / runtime
export { AGENT_NAMES, createAgent } from "./agents/index"
export { validateDelegationDepth } from "./services/governance-wiring"
import { evaluateGovernanceToolCheck } from "./services/governance-wiring"
export { evaluateGovernanceToolCheck }
export type { ValidateDelegationDepthOptions } from "./services/governance-wiring"
export { acquireLock, releaseLock } from "./services/async-lock"
export { runDoctor, formatReport, formatJSON } from "./doctor/doctor"
export { resolveDoctorExitCode } from "./doctor/exit-code.mjs"
export { redactSecrets, containsSecrets } from "./lib/secret-redaction"
export {
  getExecutingRuntimeIdentity,
  recordRuntimeSelfReport,
  readRuntimeSelfReport,
  isRuntimeRecordFresh,
} from "./services/runtime-identity"
export type { FlowDeckRuntimeIdentity } from "./services/runtime-identity"

export function cleanupSessionState(_sessionID: string): void {
}

export function getSessionMetricsDiagnostics(_sessionID: string): any {
  if (!activeRuntime) return { toolCalls: 0, retries: 0, delegations: 0, blocks: 0, warnings: 0, startTime: undefined, filesChangedCount: 0 };
  const metrics = activeRuntime.metrics;
  if (!metrics) return { toolCalls: 0, retries: 0, delegations: 0, blocks: 0, warnings: 0, startTime: undefined, filesChangedCount: 0 };
  
  // Real active runtime diagnostics
  return {
    toolCalls: metrics.executionPlans.get(),
    retries: metrics.executionStalls.get(),
    delegations: metrics.workstreamsStarted.get(),
    blocks: metrics.executionTerminations.get(),
    warnings: 0,
    startTime: undefined,
    filesChangedCount: 0
  };
}

let activeRuntime: ProductionOrchestrationRuntime | null = null;
let lifecycleAdapter: FlowDeckLifecycleAdapter | null = null;

export function getOrchestrationRuntime(): ProductionOrchestrationRuntime | null {
  return activeRuntime
}

const plugin: Plugin = async ({ directory, client: _client }) => {
  setActiveProjectDir(directory)

  if (!activeRuntime) {
    const dbPath = join(directory, ".flowdeck", "flowdeck.db");
    const initResult = initializeDatabase({ path: dbPath });
    activeRuntime = createProductionOrchestrationRuntime(initResult.db);
    lifecycleAdapter = new FlowDeckLifecycleAdapter(directory, activeRuntime);
  }

  let currentConfig: any = {};

  return {
    config: async (cfg: Record<string, unknown>) => {
      if (!(cfg as { default_agent?: string }).default_agent) {
        (cfg as { default_agent?: string }).default_agent = "heidi"
      }

      const flowdeckConfig = loadFlowDeckConfig(directory)
      currentConfig = flowdeckConfig;
      invalidateFdxCache()
      const resolvedAgents = getAgentConfigs(resolveAgentModels(flowdeckConfig))

      if (!cfg.agent) {
        cfg.agent = { ...resolvedAgents }
      } else {
        const existing = cfg.agent as Record<string, unknown>
        for (const [name, def] of Object.entries(resolvedAgents)) {
          existing[name] = existing[name] ? { ...def, ...existing[name] } : { ...def }
        }
      }

      const mcps = buildFlowDeckMcpsWithMeta().mcps
      const cfgMcp = cfg.mcp as Record<string, unknown> | undefined
      if (cfgMcp) Object.assign(cfgMcp, mcps)
      else cfg.mcp = { ...mcps }
    },

    permission: async (ctx: any) => {
      const isHeidiSession = ctx.agent?.name === "heidi" || ctx.agent?.name?.startsWith("heidi-");
      if (isHeidiSession && currentConfig?.heidi?.globalAlwaysApprove === true) {
        return { status: "allow" }
      }
      if (ctx.tool) {
        const check = evaluateGovernanceToolCheck({ directory, sessionID: ctx.sessionID, tool: ctx.tool, args: ctx.args, agent: ctx.agent?.name ?? "heidi" });
        if (check.action === "block") return { status: "deny", message: check.reason };
      }
      return undefined;
    },

    "chat.message": async (input: any, output: any) => {
      if (lifecycleAdapter) await lifecycleAdapter.onChatMessage(input, output);
    },

    "tool.execute.before": async (input: any, _output: any) => {
      if (lifecycleAdapter) await lifecycleAdapter.onToolExecuteBefore(input);
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (lifecycleAdapter) await lifecycleAdapter.onToolExecuteAfter(input, output);
    },

    event: async (input: { event: any }) => {
      if (lifecycleAdapter) await lifecycleAdapter.onEvent(input.event);
    },

    tool: {
      "doctor": doctorTool,
      "fdx-force-error": { description: "Force error", args: {}, execute: async () => { throw new Error("Intentional forced error for native failure propagation test"); } } as any,

      "codegraph": codegraphTool,
      "fdx-context": fdxContextTool,
      "fdx-decisions": fdxDecisionsTool,
      "fdx-validate": fdxValidateTool,
      "fdx-worktree": fdxWorktreeTool,
      "fdx-batch": fdxBatchTool,
      "fdx-impact": fdxImpactTool,
      "fdx-outline": fdxOutlineTool,
      "fdx-pr-monitor": fdxPrMonitorTool,
      "debug-logs": debugLogsTool,
      "heidi-memory": heidiMemoryTool,
      "heidi-recall": heidiRecallTool,
      "heidi-archive-session": heidiArchiveSessionTool,
      "heidi-learning": heidiLearningTool,
      "heidi-skill": heidiSkillTool,
      "heidi-agents": heidiAgentsTool,
    },

    dispose: async () => {
      if (activeRuntime) {
        // Safe disposal of outbox workers etc
        if ((activeRuntime as any).outboxWorker && typeof (activeRuntime as any).outboxWorker.stop === 'function') {
           (activeRuntime as any).outboxWorker.stop();
        }
      }
      configureFdxNextRuntime()
    },
  }
}

const flowDeckPlugin = {
  id: "@heidi-dang/flowdeck",
  server: plugin,
}

export default flowDeckPlugin
