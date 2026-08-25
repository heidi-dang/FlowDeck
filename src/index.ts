import type { Plugin } from "@opencode-ai/plugin"

import { getAgentConfigs } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels } from "./config/index"

import { invalidateFdxCache } from "./tools/fdx-shared"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"

import type { ProductionOrchestrationRuntime } from "./orchestration/composition"
import {
  acquireProjectRuntime,
  releaseProjectRuntime,
  getProjectRuntime,
} from "./runtime/project-registry"
import { clearRouteDecision, getRouteDecision } from "./services/heidi-route-state"
import { clearTaskState } from "./services/heidi-task-state"
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

/**
 * Cleans up ephemeral in-memory state for a session while preserving durable database history.
 * Resolves route state first to clear the actual taskId from HeidiTaskState.
 */
export function cleanupSessionState(sessionID: string): void {
  const route = getRouteDecision(sessionID);
  if (route && route.taskId) {
    clearTaskState(route.taskId);
  }
  clearRouteDecision(sessionID);
}

/**
 * Returns session execution diagnostics backed by authoritative database rows.
 * Strictly read-only: does NOT create runtime, databases, or directories if missing.
 */
export function getSessionMetricsDiagnostics(sessionID: string, directory?: string): {
  sessionID: string;
  runID?: string;
  toolCalls: number;
  delegations: number;
  status?: string;
  startTime?: string;
  completedAt?: string | null;
  errorMessage?: string | null;
  activeAssignments?: number;
  completedAssignments?: number;
  failedAssignments?: number;
  activeChildExecutions?: number;
  completedChildExecutions?: number;
  failedChildExecutions?: number;
  lastProgressAt?: string;
  noProgressCount?: number;
  lastProgressReason?: string;
  stallReason?: string;
  lastEvidenceDelta?: number;
  lastRepositoryDelta?: number;
  isStalled?: boolean;
  executionMode?: "DIRECT" | "SINGLE_SPECIALIST" | "MULTI_SPECIALIST";
  specialistState?: {
    planned: number;
    active: number;
    completed: number;
    failed: number;
    blocked: number;
    required: number;
    optional: number;
    attempts: number;
    deduplicated: number;
    fanoutBlocked: number;
    reasonCode?: string;
    rejectedReason?: string;
  };
  childExecutions?: Array<{
    assignmentId: string;
    executionId: string;
    agentId: string;
    taskCallId: string;
    specialistId?: string;
    childSessionId?: string;
    status: string;
    startedAt?: string;
    completedAt?: string | null;
  }>;
} {
  const projectCtx = directory ? getProjectRuntime(directory) : null;
  if (!projectCtx || !projectCtx.runtime) {
    return { sessionID, toolCalls: 0, delegations: 0 };
  }

  const sessionRow = projectCtx.runtime.sessionRepo.findById(sessionID);
  if (!sessionRow) {
    return { sessionID, toolCalls: 0, delegations: 0 };
  }

  const childDiag = sessionRow.runId
    ? projectCtx.runtime.childExecutionLifecycleService.getDiagnosticsForRun(sessionRow.runId)
    : undefined;

  const progDiag = sessionRow.runId
    ? projectCtx.runtime.progressObservationService.getDiagnosticsForRun(sessionRow.runId)
    : undefined;
  const orchestrationSnapshot = sessionRow.runId
    ? projectCtx.runtime.orchestrationSnapshotService.getSnapshot(sessionRow.runId, sessionID)
    : undefined;

  return {
    sessionID: sessionRow.id,
    runID: sessionRow.runId,
    toolCalls: sessionRow.toolCalls,
    delegations: sessionRow.delegations,
    status: sessionRow.status,
    startTime: sessionRow.startedAt,
    completedAt: sessionRow.completedAt,
    errorMessage: sessionRow.errorMessage,
    activeAssignments: childDiag?.activeAssignments,
    completedAssignments: childDiag?.completedAssignments,
    failedAssignments: childDiag?.failedAssignments,
    activeChildExecutions: childDiag?.activeChildExecutions,
    completedChildExecutions: childDiag?.completedChildExecutions,
    failedChildExecutions: childDiag?.failedChildExecutions,
    lastProgressAt: progDiag?.lastProgressAt,
    noProgressCount: progDiag?.noProgressCount,
    lastProgressReason: progDiag?.lastProgressReason,
    stallReason: progDiag?.stallReason,
    lastEvidenceDelta: progDiag?.lastEvidenceDelta,
    lastRepositoryDelta: progDiag?.lastRepositoryDelta,
    isStalled: progDiag?.isStalled,
    executionMode: orchestrationSnapshot?.executionMode,
    specialistState: orchestrationSnapshot?.specialistState,
    childExecutions: childDiag?.childExecutions,
  };
}

/**
 * Get active ProductionOrchestrationRuntime for a directory if one exists.
 * Strictly read-only: does NOT create runtime if missing.
 */
export function getOrchestrationRuntime(directory?: string): ProductionOrchestrationRuntime | null {
  if (!directory) return null;
  const ctx = getProjectRuntime(directory);
  return ctx ? ctx.runtime : null;
}

const plugin: Plugin = async ({ directory, client: _client }) => {
  setActiveProjectDir(directory)
  const projectContext = acquireProjectRuntime(directory, _client);
  const lifecycleAdapter = projectContext.adapter;

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
      // 1. Evaluate non-bypassable FlowDeck correctness & governance invariants FIRST
      if (ctx.tool) {
        const check = evaluateGovernanceToolCheck({
          directory,
          sessionID: ctx.sessionID,
          tool: ctx.tool,
          args: ctx.args,
          agent: ctx.agent?.name ?? "heidi",
        });

        // Structural blocks can NEVER be bypassed by user approval settings
        if (check.action === "block") {
          return { status: "deny", message: check.reason };
        }
      }

      // 2. User permission policy: globalAlwaysApprove suppresses user prompts for valid operations
      const isHeidiSession = ctx.agent?.name === "heidi" || ctx.agent?.name?.startsWith("heidi-");
      if (isHeidiSession && currentConfig?.heidi?.globalAlwaysApprove === true) {
        return { status: "allow" };
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
      await releaseProjectRuntime(directory);
      configureFdxNextRuntime()
    },
  }
}

const flowDeckPlugin = {
  id: "@heidi-dang/flowdeck",
  server: plugin,
}

export default flowDeckPlugin
