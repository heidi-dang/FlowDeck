/**
 * FlowDeck Plugin Entry Point
 *
 * Integrates all subsystems into the OpenCode plugin lifecycle:
 * - Agent registry (from canonical registry)
 * - Governance wiring (validator, supervisor, loop detector, audit, verification)
 * - Tool permissions (orchestrator guard, tool guard, guard rails)
 * - State management (session start/end, checkpoint, recovery)
 * - FDX tools with native fallbacks
 * - MCP server configurations
 * - Skills and commands registration
 * - Doctor diagnostics
 */

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"

import {
  buildSelectionDiagnostics,
  detectProjectLanguages,
  getStartupRulePaths,
  selectRulePaths,
} from "./services/lazy-rule-loader"
import { LoopDetector } from "./services/loop-detector"

import { getAgentConfigs, getAgentRoutes } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels, type FlowDeckConfig } from "./config/index"
import { guardRailsHook } from "./hooks/guard-rails"
import { OrchestratorGuard } from "./hooks/orchestrator-guard-hook"
import { sessionStartHook } from "./hooks/session-start"
import { sessionEventsHook } from "./hooks/session-events"
import { executePostWriteHook, clearWriteCounter, toolGuardHook } from "./hooks/tool-guard"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"
import { captureLessonTool, reviewLessonsTool } from "./tools/capture-lesson"
import { codegraphTool } from "./tools/codegraph-tool"
import { codebaseStateTool } from "./tools/codebase-state"
import { doctorTool } from "./tools/doctor"
import { fdxValidateTool } from "./tools/fdx-validate"
import { fdxWorktreeTool } from "./tools/fdx-worktree"
import {
  fdxBatchTool,
  fdxContextTool,
  fdxDecisionsTool,
  fdxDiffTool,
  fdxGitTool,
  fdxGrepTool,
  fdxImpactTool,
  fdxLintTool,
  fdxLsTool,
  fdxOutlineTool,
  fdxReadTool,
  fdxSearchTool,
  fdxTestTool,
  fdxTreeTool,
  setActiveProjectDir,
} from "./tools/fdx"
import { fdxPrMonitorTool } from "./tools/fdx-pr-monitor"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"
import { debugLogsTool } from "./tools/debug-logs"
import { HarnessRuntime } from "./better-harness/runtime/harness-runtime"
import { HarnessHttpServer } from "./better-harness/transport/http-server"
import { SseManager } from "./better-harness/transport/sse"
import { ProjectRegistry } from "./better-harness/runtime/project-registry"
import type { BetterHarnessConfig } from "./config/schema"
import type { RouterContext } from "./better-harness/runtime/router-context"

// ─── Governance integration ────────────────────────────────────────────────
import {
  evaluateGovernanceToolCheck,
  recordRecoveryAudit,
  executeVerifiedPostWrite,
  generateScorecard,
  validateDelegationDepth,
  resolveGovernanceMode,
} from "./services/governance-wiring"
import { runSupervisorReview, shouldProceed, resolveSupervisorConfig } from "./services/supervisor-binding"
import { appendAuditEvent } from "./services/audit-log"
import { isSpecialistAgent, getAllAgentIds } from "./services/canonical-registry"
import {
  resolveRuntimeAgentConfig,
  enforceRuntimeAgent,
  applyIdentityMarker,
} from "./services/runtime-agent-policy"
import { normalizeTaskInvocation } from "./services/task-invocation-adapter"
import { TokenBudgetRuntime } from "./services/token-budget-runtime"
import { getArtifactStore } from "./services/artifact-store"
import { buildAssignmentContext, externalizeToolOutput, compactConversationContext } from "./services/context-scoping"
import { initializeDatabase } from "./orchestration/persistence/index"
import { createProductionOrchestrationRuntime, type ProductionOrchestrationRuntime } from "./orchestration/composition"
import { runShadowAssessment } from "./orchestration/routing/shadow"
import { execFileSync } from "node:child_process"

// ─── Session budget tracking ──────────────────────────────────────────────
const sessionToolCalls = new Map<string, number>()
const sessionRetries = new Map<string, number>()
const sessionDelegations = new Map<string, number>()
const sessionBlocks = new Map<string, number>()
const sessionWarnings = new Map<string, number>()
const sessionStartTimes = new Map<string, number>()
const sessionFilesChanged = new Map<string, Set<string>>()
interface RuntimeSessionMetadata {
  sessionID: string
  parentID?: string
  agent?: string
  depth: number
}

interface ChildTaskCorrelation {
  parentSessionID: string
  callID: string
  taskKey: string
  targetAgent: string
}

const sessionRegistry = new Map<string, RuntimeSessionMetadata>()
const sessionCallerAgents = new Map<string, string>()
export const sessionTaskCalls = new Map<
  string,
  { callerAgent: string; targetAgent: string; startedAt: number; resolvedFrom: string }
>()
export const childSessionToTask = new Map<string, ChildTaskCorrelation>()
/**
 * FIFO pending-slot queue per (parentSessionID, targetAgent).
 * Enqueued in tool.execute.before when a task call is registered.
 * Dequeued in the event handler when the child session is created.
 * Eliminates ambiguous correlation when multiple concurrent calls
 * target the same agent — the queue order (call insertion order)
 * is deterministic.
 */
const pendingChildSlots = new Map<string, ChildTaskCorrelation[]>()

function enqueuePendingSlot(
  parentSessionID: string,
  callID: string,
  taskKey: string,
  targetAgent: string,
): void {
  const key = `${parentSessionID}:${targetAgent}`
  let queue = pendingChildSlots.get(key)
  if (!queue) {
    queue = []
    pendingChildSlots.set(key, queue)
  }
  queue.push({ parentSessionID, callID, taskKey, targetAgent })
}

/**
 * Dequeue the next pending slot for the given parent and target agent.
 *
 * When the child session's agent is known and the pending queue has exactly
 * one call for that agent, the correlation is authoritative.
 *
 * When the queue has multiple calls to the SAME agent, returns ambiguous
 * (unresolved) rather than guessing via FIFO — attaching failure to a
 * potentially incorrect task is worse than no correlation.
 *
 * When the child session's agent is unknown/absent and there are multiple
 * queues with pending calls for different targets, also returns ambiguous
 * (unresolved) rather than attaching to an arbitrary task.
 */
function dequeuePendingSlot(
  parentSessionID: string,
  effectiveTarget?: string,
): { correlation: ChildTaskCorrelation | null; ambiguous: boolean } {
  if (effectiveTarget && effectiveTarget !== "unknown") {
    // Exact agent match
    const key = `${parentSessionID}:${effectiveTarget}`
    const queue = pendingChildSlots.get(key)
    if (queue && queue.length > 0) {
      // Multiple pending calls to the same target agent — cannot determine
      // which specific task call created this child session. Return
      // ambiguous so the caller can emit an unresolved-correlation
      // diagnostic rather than attaching failure to a potentially
      // incorrect task.
      if (queue.length > 1) {
        return { correlation: null, ambiguous: true }
      }
      const correlation = queue.shift()!
      if (queue.length === 0) pendingChildSlots.delete(key)
      return { correlation, ambiguous: false }
    }
    // No pending slot for this exact agent — nothing to correlate
    return { correlation: null, ambiguous: false }
  }

  // Agent is unknown — scan all queues for this parent
  let found: ChildTaskCorrelation | null = null
  let count = 0
  for (const [key, queue] of pendingChildSlots.entries()) {
    if (key.startsWith(`${parentSessionID}:`) && queue.length > 0) {
      count++
      if (!found) found = queue[0]
    }
  }
  if (count === 0) return { correlation: null, ambiguous: false }
  if (count > 1) return { correlation: null, ambiguous: true }

  // Exactly one pending slot for this parent — safe to use
  const agentKey = `${parentSessionID}:${found!.targetAgent}`
  const agentQueue = pendingChildSlots.get(agentKey)
  const correlation = agentQueue?.shift() ?? null
  if (agentQueue?.length === 0) pendingChildSlots.delete(agentKey)
  return { correlation, ambiguous: false }
}

function cleanupPendingSlots(sessionID: string): void {
  for (const [key, queue] of pendingChildSlots.entries()) {
    if (key.startsWith(`${sessionID}:`)) {
      // Shift entries owned by this session
      const remaining = queue.filter(c => c.parentSessionID !== sessionID)
      if (remaining.length === 0) {
        pendingChildSlots.delete(key)
      } else {
        pendingChildSlots.set(key, remaining)
      }
    }
  }
}

const __dir = dirname(fileURLToPath(import.meta.url))

function lazyLoadRulePaths(projectRoot: string): { paths: string[]; diagnostics: string } {
  const rulesDir = join(__dir, "..", "src", "rules")
  if (!existsSync(rulesDir)) return { paths: [], diagnostics: "[LazyRuleLoader] rules directory not found" }
  const detected = detectProjectLanguages(projectRoot)
  const paths = getStartupRulePaths(rulesDir, detected)
  const selection = selectRulePaths(rulesDir, { languages: detected, projectRoot })
  return { paths, diagnostics: buildSelectionDiagnostics(selection, { languages: detected, projectRoot }) }
}

function loadCommands(): Record<string, { description?: string; template: string }> {
  const dir = join(__dir, "..", "src", "commands")
  if (!existsSync(dir)) return {}
  const out: Record<string, { description?: string; template: string }> = {}
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const raw = readFileSync(join(dir, file), "utf-8")
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      const template = fm ? fm[2].trim() : raw
      const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
      out[basename(file, ".md")] = desc ? { description: desc, template } : { template }
    }
  } catch { /* ignore read errors */ }
  return out
}

const specialistAgentSet = new Set(getAllAgentIds().filter(id => isSpecialistAgent(id)))

const plugin: Plugin = async ({ directory, client }) => {
  // ─── Structured logging ──────────────────────────────────────────────
  let logSequence = 0
  type LogLevel = "debug" | "info" | "warn" | "error"
  const appLog = (msg: string, level: LogLevel = "info", sessionID?: string): Promise<void> => {
    const correlationId = sessionID ? `${sessionID}:${++logSequence}` : `anon:${++logSequence}`
    return client.app.log({
      body: {
        service: "flowdeck",
        level,
        message: msg,
        extra: { correlationId, timestamp: new Date().toISOString() },
      },
    }).then(() => undefined).catch(() => {})
  }

  setActiveProjectDir(directory)
  const artifactStore = getArtifactStore(join(directory, ".flowdeck", "artifacts"))

  let flowdeckConfig: FlowDeckConfig = loadFlowDeckConfig(directory)
  const orchestratorGuard = new OrchestratorGuard({ routes: getAgentRoutes() })
  const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)
  let effectiveDefaultAgent: string = "heidi"

  // ─── Hierarchical token-budget control ────────────────────────────────
  const tokenBudgetRuntime = TokenBudgetRuntime.fromConfig(flowdeckConfig, {
    directory,
    onWarning: (runId, message) => {
      appLog(`[token-budget] ${message}`, "warn")
    },
    onTerminal: (runId, reason) => {
      appLog(`[token-budget] Run ${runId} terminal: ${reason}`, "warn")
    },
  })

  const maxToolCalls = flowdeckConfig.governance?.delegationBudget?.maxToolCalls ?? 200
  const maxRetries = flowdeckConfig.governance?.delegationBudget?.maxSameStepRetries ?? 3
  const maxDelegations = flowdeckConfig.governance?.delegationBudget?.maxDelegations ?? 20
  const maxDepth = flowdeckConfig.governance?.delegationBudget?.maxDepth ?? 1

  const { mcps } = buildFlowDeckMcpsWithMeta()

  // --- Better Harness integration using shared graph ------------------------
  let betterHarnessRuntime: HarnessRuntime | null = null
  let betterHarnessServer: HarnessHttpServer | null = null
  let betterHarnessSseManager: SseManager | null = null
  let _betterHarnessCleanup: (() => void) | null = null

  const projectRegistry = new ProjectRegistry()
  const bhConfig: BetterHarnessConfig | undefined = flowdeckConfig.betterHarness
  if (bhConfig?.enabled) {
    // Create runtime (it creates its own coordinator internally)
    betterHarnessRuntime = new HarnessRuntime({
      projectRoot: directory,
      timeoutMs: 120_000,
    })

    // Register project in registry
    projectRegistry.register({
      serverKey: "default",
      projectKey: basename(directory),
      canonicalProjectRoot: directory,
    })

    const coordinator = betterHarnessRuntime.getCoordinator()
    const eventBus = coordinator.getEventBus()

    const eventLogDir = bhConfig.eventLogDir
    betterHarnessSseManager = new SseManager(eventBus, eventLogDir)

    // Build auth config
    const authToken = bhConfig.authToken ?? null
    const authEnabled = bhConfig.authEnabled ?? false

    // Build router context with all dependencies
    const routerContext: RouterContext = {
      runtime: betterHarnessRuntime,
      coordinator,
      resolveProjectPath: (serverKey: string, projectKey: string) => {
        return projectRegistry.resolve(serverKey, projectKey)
      },
      sseManager: betterHarnessSseManager,
      authToken: authToken ?? undefined,
      bindHost: bhConfig.bindHost ?? "127.0.0.1",
      opencodeClient: client,
    }

    betterHarnessServer = new HarnessHttpServer({
      enabled: true,
      port: bhConfig.port ?? 0,
      bindHost: bhConfig.bindHost ?? "127.0.0.1",
      auth: {
        token: authToken ?? undefined,
        enabled: authEnabled,
      },
      maxBodySize: bhConfig.maxBodySize ?? 1024 * 1024,
    })
    betterHarnessServer.setSseManager(betterHarnessSseManager)
    betterHarnessServer.setRouterContext(routerContext)

    betterHarnessServer.start().then((port) => {
      appLog("[better-harness] HTTP server started on port " + port)
    }).catch((err: Error) => {
      appLog("[better-harness] Failed to start HTTP server: " + err.message, "error")
    })

    coordinator.recoverActiveRuns()

    // Set up cleanup
    _betterHarnessCleanup = () => {
      betterHarnessServer?.stop().catch(() => {})
      projectRegistry.unregister(basename(directory))
    }
  }

  // ─── Production Orchestration Runtime Initialization ───────────────
  try {
    const dbPath = join(directory, ".flowdeck", "flowdeck.db")
    const { db } = initializeDatabase({ path: dbPath })
    activeOrchestrationRuntime = createProductionOrchestrationRuntime(db, { repositoryPath: directory, worktreeRoot: join(directory, ".flowdeck", "worktrees") })
    appLog("[orchestration] Production orchestration runtime initialized successfully")
  } catch (err) {
    appLog(`[orchestration] Production orchestration runtime initialization skipped: ${err instanceof Error ? err.message : String(err)}`, "warn")
  }

  return {
    config: async (cfg: Record<string, unknown>) => {
      if (!(cfg as { default_agent?: string }).default_agent) {
        (cfg as { default_agent?: string }).default_agent = "heidi"
      }
      effectiveDefaultAgent = (cfg as { default_agent?: string }).default_agent ?? "heidi"

      flowdeckConfig = loadFlowDeckConfig(directory)
      const resolvedAgents = getAgentConfigs(resolveAgentModels(flowdeckConfig))

      if (!cfg.agent) {
        cfg.agent = { ...resolvedAgents }
      } else {
        const existing = cfg.agent as Record<string, unknown>
        for (const [name, def] of Object.entries(resolvedAgents)) {
          existing[name] = existing[name] ? { ...def, ...existing[name] } : { ...def }
        }
      }

      const cfgMcp = cfg.mcp as Record<string, unknown> | undefined
      if (cfgMcp) Object.assign(cfgMcp, mcps)
      else cfg.mcp = { ...mcps }

      const commands = loadCommands()
      if (Object.keys(commands).length > 0) {
        if (!cfg.command || typeof cfg.command !== "object") cfg.command = {}
        const cfgCmd = cfg.command as Record<string, unknown>
        for (const [name, cmd] of Object.entries(commands)) {
          if (!cfgCmd[name]) cfgCmd[name] = cmd
        }
      }

      const skillsDir = join(__dir, "..", "src", "skills")
      if (existsSync(skillsDir)) {
        const cfgAny = cfg as Record<string, unknown>
        const skills = (cfgAny.skills && typeof cfgAny.skills === "object" ? cfgAny.skills : { paths: [] }) as { paths?: string[] }
        if (!skills.paths) skills.paths = []
        if (!skills.paths.includes(skillsDir)) skills.paths.push(skillsDir)
        cfgAny.skills = skills
      }

      const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
      appLog(diagnostics)
      if (rulePaths.length > 0) {
        if (!Array.isArray(cfg.instructions)) cfg.instructions = []
        const seen = new Set(cfg.instructions as string[])
        for (const p of rulePaths) if (!seen.has(p)) (cfg.instructions as string[]).push(p)
      }
    },

    "chat.message": async (input: { sessionID: string; agent?: string; variant?: string }, output: { message: any; parts?: any[] }) => {
      const sessionID = input.sessionID ?? ""
      const agent = output.message?.agent ?? input.agent ?? "unknown"
      if (sessionID && agent && agent !== "unknown") {
        sessionCallerAgents.set(sessionID, agent)
        let meta = sessionRegistry.get(sessionID)
        if (meta) {
          meta.agent = agent
        } else {
          sessionRegistry.set(sessionID, { sessionID, depth: 0, agent })
        }
      }

      const sessionMeta = sessionID ? sessionRegistry.get(sessionID) : undefined
      const isSubagent = Boolean(sessionMeta?.parentID) || (sessionMeta?.depth ?? 0) > 0

      // Milestone 1 routing is advisory only. It observes the incoming task,
      // persists a decision, and never changes the existing execution path.
      const routingMode = flowdeckConfig.routing?.enabled ? (flowdeckConfig.routing.mode ?? "shadow") : "off"
      const taskText = typeof output.message?.content === "string" ? output.message.content : ""
      if (routingMode === "shadow" && taskText.trim()) {
        let sourceSha = process.env.FLOWDECK_SOURCE_SHA
        if (!sourceSha) {
          try { sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim() } catch { sourceSha = "0000000000000000000000000000000000000000" }
        }
        runShadowAssessment({ runId: sessionID || "sessionless", sourceSha, task: taskText }, "existing", routingMode, activeOrchestrationRuntime?.routingDecisionRepository, activeOrchestrationRuntime?.metrics)
      }

      const variant = input.variant
      const pkgVersion = "2.0.0-alpha.1"
      const runtimeCfg = resolveRuntimeAgentConfig(flowdeckConfig, effectiveDefaultAgent)
      const result = enforceRuntimeAgent({
        sessionID,
        agent,
        variant,
        expectedAgent: runtimeCfg.expectedAgent ?? "heidi",
        enforcement: runtimeCfg.enforcement,
        directory: directory,
        isSubagentSession: isSubagent,
        packageVersion: pkgVersion,
      })

      if (!result.allowed) {
        throw new Error(result.reason ?? "Agent identity enforcement blocked this request")
      }

      // ── Context Compaction ───────────────────────────────────────────
      // Compact intermediate conversation turns when token footprint exceeds the
      // configured threshold — runs before the budget gate to reduce reservation size.
      if (sessionID && output.message?.messages && Array.isArray(output.message.messages)) {
        const tokenConfig = tokenBudgetRuntime.getConfig()
        const compactResult = compactConversationContext({
          messages: output.message.messages,
          thresholdTokens: tokenConfig.compactThresholdTokens,
          sessionID,
        })
        if (compactResult.compacted) {
          output.message.messages = compactResult.messages
          appLog(
            `[context-compaction] session=${sessionID} ${compactResult.originalTokens}->${compactResult.compactedTokens} tokens`,
            "info",
            sessionID,
          )
        }
      }

      // ── Hierarchical token-budget pre-dispatch gate ──────────────────
      // Reserve budget before the model request is sent. When the run or
      // child budget cannot cover the estimated request, abort the call.
      if (sessionID && tokenBudgetRuntime.isEnabled()) {
        const budgetCtx = {
          sessionID,
          agent,
          parentID: sessionMeta?.parentID,
          depth: sessionMeta?.depth ?? 0,
        }
        const budget = await tokenBudgetRuntime.beforeDispatch(budgetCtx, output.message, {
          model: output.message?.modelID,
          provider: output.message?.providerID,
        })
        if (!budget.allowed) {
          throw new Error(
            `TOKEN_BUDGET_EXCEEDED: ${budget.reason ?? "budget exhausted"} (run ${budget.runId}, remaining ${budget.remainingRun})`,
          )
        }
      }

      // Apply identity anti-fabrication marker
      if (output.message?.system !== undefined) {
        output.message.system = applyIdentityMarker(
          output.message.system,
          agent,
          runtimeCfg.expectedAgent ?? "heidi",
        )
      } else if (output.message) {
        output.message.system = applyIdentityMarker("", agent, runtimeCfg.expectedAgent ?? "heidi")
      }
    },

    tool: {
      "doctor": doctorTool,
      "planning-state": planningStateTool,
      "codebase-state": codebaseStateTool,
      "repo-memory": repoMemoryTool,
      "hash-edit": hashEditTool,
      "codegraph": codegraphTool,
      "load-rules": loadRulesTool,
      "list-rules": listRulesTool,
      "capture-lesson": captureLessonTool,
      "review-lessons": reviewLessonsTool,
      "fdx-context": fdxContextTool,
      "fdx-decisions": fdxDecisionsTool,
      "fdx-validate": fdxValidateTool,
      "fdx-worktree": fdxWorktreeTool,
      "fdx-read": fdxReadTool,
      "fdx-search": fdxSearchTool,
      "fdx-grep": fdxGrepTool,
      "fdx-batch": fdxBatchTool,
      "fdx-impact": fdxImpactTool,
      "fdx-outline": fdxOutlineTool,
      "fdx-diff": fdxDiffTool,
      "fdx-git": fdxGitTool,
      "fdx-ls": fdxLsTool,
      "fdx-tree": fdxTreeTool,
      "fdx-test": fdxTestTool,
      "fdx-lint": fdxLintTool,
      "debug-audit": debugLogsTool,
    "fdx-pr-monitor": fdxPrMonitorTool,
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const callID = toolInput.callID ?? ""
      const rawArgs = toolOutput?.args ?? toolInput?.args ?? {}
      const sessionMeta = sessionID ? sessionRegistry.get(sessionID) : undefined
      const resolvedCaller = sessionMeta?.agent ?? (sessionID ? sessionCallerAgents.get(sessionID) : undefined) ?? toolInput.agent

      if (toolName === "task" && (!resolvedCaller || resolvedCaller === "unknown")) {
        const govMode = resolveGovernanceMode(directory)
        if (govMode === "strict") {
          appendAuditEvent(directory, {
            kind: "delegation.blocked",
            session_id: sessionID,
            tool: toolName,
            decision: "block",
            reason: "TASK_CALLER_UNRESOLVED: Unable to resolve calling agent identity for Task execution",
          })
          throw new Error("TASK_CALLER_UNRESOLVED: Unable to resolve calling agent identity for Task execution")
        }
      }

      const agent = resolvedCaller || "heidi"

      // ── 0. Tool call budget tracking ─────────────────────────────────
      if (sessionID) {
        const callCount = (sessionToolCalls.get(sessionID) ?? 0) + 1
        sessionToolCalls.set(sessionID, callCount)
        if (callCount > maxToolCalls) {
          const msg = `Tool call budget exceeded: ${callCount} > ${maxToolCalls} for session ${sessionID}`
          const govMode = resolveGovernanceMode(directory)
          recordRecoveryAudit({
            directory, sessionID, agent,
            errorKey: "tool_call_budget_exceeded",
            action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
            message: msg,
          })
          if (govMode === "strict") {
            throw new Error(msg)
          }
          appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
        }
      }

      // ── 1. Orchestrator guard ──────────────────────────────────────────
      orchestratorGuard.check(
        sessionID,
        toolName,
        rawArgs,
        agent,
      )

      // ── 2. Governance tool check ────────────────────────────────
      const governanceResult = evaluateGovernanceToolCheck({
        directory,
        sessionID,
        agent,
        tool: toolName,
        args: rawArgs,
      })

      if (governanceResult.action === "block") {
        if (sessionID) sessionBlocks.set(sessionID, (sessionBlocks.get(sessionID) ?? 0) + 1)
        throw new Error(governanceResult.reason ?? `Tool ${toolName} blocked by governance policy`)
      }
      if (governanceResult.action === "warn") {
        if (sessionID) sessionWarnings.set(sessionID, (sessionWarnings.get(sessionID) ?? 0) + 1)
      }

      // ── 3. Delegation depth check & budget ───────────────────────────
      if (toolName === "task") {
        const invocation = normalizeTaskInvocation(
          { sessionID, callID, agent },
          rawArgs,
        )

        // Scope child prompt using buildAssignmentContext to enforce context packet boundaries
        const rawTaskPrompt = (rawArgs.prompt as string) ?? (rawArgs.description as string) ?? ""
        if (rawTaskPrompt) {
          const assignmentCtx = buildAssignmentContext({
            assignment: rawTaskPrompt,
            target: (rawArgs.target as string) || (rawArgs.file as string) || undefined,
            stage: (rawArgs.stage as string) || undefined,
          })
          rawArgs.prompt = assignmentCtx.prompt
          if (toolOutput?.args) toolOutput.args.prompt = assignmentCtx.prompt
          if (toolInput?.args) toolInput.args.prompt = assignmentCtx.prompt
        }
        const targetAgent = invocation.targetAgent

        // Only run delegation validation if a delegation target is present.
        // Do NOT return early if missing — let governance hooks (4, 5, 6, 7) run!
        if (targetAgent && targetAgent.trim() !== "") {
          const isSpecialistCaller = isSpecialistAgent(invocation.callerAgent)
          const isChildSession = Boolean(sessionMeta?.parentID) || (sessionMeta?.depth ?? 0) > 0
          const currentDepth = isChildSession ? (sessionMeta?.depth && sessionMeta.depth > 0 ? sessionMeta.depth : 1) : (isSpecialistCaller ? 1 : 0)

          const depthResult = validateDelegationDepth(
            invocation.callerAgent,
            targetAgent,
            currentDepth,
            specialistAgentSet,
            maxDepth,
          )
          if (!depthResult.allowed) {
            const errorCode = depthResult.errorCode ?? "DELEGATION_BLOCKED"
            const isTerminal = errorCode === "SELF_DELEGATION_BLOCKED" || errorCode === "MISSING_TARGET_AGENT"

            appendAuditEvent(directory, {
              kind: "delegation.blocked",
              session_id: sessionID,
              agent: invocation.callerAgent,
              tool: toolName,
              decision: "block",
              reason: depthResult.reason ?? "Delegation blocked",
              details: {
                callID,
                targetAgent,
                errorCode,
                resolvedFrom: invocation.resolvedFrom,
              },
            })

            recordRecoveryAudit({
              directory,
              sessionID,
              agent: invocation.callerAgent,
              errorKey: errorCode,
              action: isTerminal ? "circuit_breaker_block" : "targeted_diagnosis",
              message: depthResult.reason ?? "Delegation not allowed",
            })
            if (sessionID && !isTerminal) sessionBlocks.set(sessionID, (sessionBlocks.get(sessionID) ?? 0) + 1)
            throw new Error(`${errorCode}: ${depthResult.reason ?? "Delegation blocked"}`)
          }

          // Calculate next delegation count & validate budget BEFORE registering call or emitting delegation.started
          const nextDelCount = (sessionDelegations.get(sessionID) ?? 0) + 1
          if (nextDelCount > maxDelegations) {
            const msg = `Delegation budget exceeded: ${nextDelCount} > ${maxDelegations} for session ${sessionID}`
            const govMode = resolveGovernanceMode(directory)
            appendAuditEvent(directory, {
              kind: "delegation.blocked",
              session_id: sessionID,
              agent: invocation.callerAgent,
              tool: toolName,
              decision: "block",
              reason: msg,
              details: {
                callID,
                targetAgent,
                errorCode: "DELEGATION_BUDGET_EXCEEDED",
                resolvedFrom: invocation.resolvedFrom,
              },
            })
            recordRecoveryAudit({
              directory, sessionID, agent: invocation.callerAgent,
              errorKey: "DELEGATION_BUDGET_EXCEEDED",
              action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
              message: msg,
            })
            if (govMode === "strict") {
              throw new Error(`DELEGATION_BUDGET_EXCEEDED: ${msg}`)
            }
            appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
          }

          if (sessionID) {
            sessionDelegations.set(sessionID, nextDelCount)
          }

          const taskKey = `${sessionID}:${callID || "task"}`
          sessionTaskCalls.set(taskKey, {
            callerAgent: invocation.callerAgent,
            targetAgent,
            startedAt: Date.now(),
            resolvedFrom: invocation.resolvedFrom,
          })

          // Enqueue a pending child-slot so the event handler can
          // correlate the child session deterministically even when
          // multiple concurrent calls target the same agent.
          // The FIFO queue guarantees that the first-created task call
          // is linked to the first-created child session.
          enqueuePendingSlot(sessionID, callID, taskKey, targetAgent)

          appendAuditEvent(directory, {
            kind: "delegation.started",
            session_id: sessionID,
            agent: invocation.callerAgent,
            tool: toolName,
            decision: "allow",
            details: {
              callID,
              targetAgent,
              resolvedFrom: invocation.resolvedFrom,
              promptLength: invocation.promptLength,
              promptSnippet: invocation.promptSnippet,
            },
          })
        }
      }

      // ── 4. Supervisor preflight review ────────────────────────────────
      const supConfig = resolveSupervisorConfig(directory)
      if (supConfig.enabled) {
        const decision = runSupervisorReview(directory, toolName, {
          currentPhase: rawArgs?.phase as string | undefined,
          isTrivial: rawArgs?.trivial === true,
        })
        if (!shouldProceed(decision, supConfig.mode, supConfig.canBlock)) {
          appendAuditEvent(directory, {
            kind: "supervisor.block",
            session_id: sessionID,
            agent,
            tool: toolName,
            decision: "block",
            reason: decision.reasons.join("; "),
          })
          throw new Error(`Supervisor blocked: ${decision.reasons.join("; ")}`)
        }
        appendAuditEvent(directory, {
          kind: "supervisor.approve",
          session_id: sessionID,
          agent,
          tool: toolName,
          decision: "approve",
          reason: "Supervisor approved execution",
        })
      }

      // ── 5. Guard rails ──────────────────────────────────────────────
      await guardRailsHook({ directory }, toolInput, toolOutput)

      // ── 6. Tool guard ───────────────────────────────────────────────
      await toolGuardHook({ directory }, toolInput, toolOutput)

      // ── 7. Loop detection ────────────────────────────────────────────
      const loop = loopDetector.checkBefore(
        toolName,
        rawArgs,
        sessionID,
      )
      if (loop.action === "block") throw new Error(loop.escalationMessage)
      if (loop.action === "warn") appLog(loop.message, "warn", sessionID)
    },

    "tool.execute.after": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const callID = toolInput.callID ?? ""
      const agent = sessionCallerAgents.get(sessionID) ?? toolInput.agent ?? "unknown"
      const rawArgs = toolOutput?.args ?? toolInput?.args ?? {}
      appLog(`[tool] done tool=${toolName} session=${sessionID}`)

      // ── Tool Output Externalisation ───────────────────────────────────
      // If the tool output is oversized, archive in ArtifactStore and return reference marker
      if (sessionID && tokenBudgetRuntime.isEnabled()) {
        const tokenConfig = tokenBudgetRuntime.getConfig()
        const maxChars = tokenConfig.maxToolOutputChars
        const outputFields = ["output", "result", "content"]
        for (const field of outputFields) {
          if (toolOutput && typeof toolOutput[field] === "string" && toolOutput[field].length > maxChars) {
            const ext = externalizeToolOutput(toolOutput[field], maxChars, {
              sessionID,
              toolName,
              artifactStore,
            })
            if (ext.truncated) {
              toolOutput[field] = ext.text
              appLog(
                `[tool-externalisation] Externalised output for tool=${toolName} session=${sessionID} (${ext.originalChars} -> ${ext.retainedChars} chars, id=${ext.artifactId})`,
                "info",
                sessionID,
              )
            }
          }
        }
      }

      if (sessionID && toolName && rawArgs.file && !toolInput.error && !toolOutput?.error) {
        if (!sessionFilesChanged.has(sessionID)) {
          sessionFilesChanged.set(sessionID, new Set())
        }
        sessionFilesChanged.get(sessionID)!.add(String(rawArgs.file))
      }

      executePostWriteHook(directory, sessionID, agent, toolName, rawArgs)

      executeVerifiedPostWrite(directory, {
        sessionID,
        agent,
        tool: toolName,
        filePath: rawArgs.file as string | undefined,
      })

      loopDetector.recordAfter(
        toolName,
        rawArgs,
        toolInput.output ?? toolOutput?.output ?? toolOutput?.result ?? "[unavailable]",
        sessionID,
        "success"
      )

      if (toolName === "task") {
        const taskKey = `${sessionID}:${callID || "task"}`
        const taskCall = sessionTaskCalls.get(taskKey)
        const hasError = !!toolInput.error || !!toolOutput?.error || toolOutput === undefined || toolOutput === null

        if (taskCall) {
          const durationMs = Date.now() - taskCall.startedAt
          if (hasError) {
            appendAuditEvent(directory, {
              kind: "delegation.failed",
              session_id: sessionID,
              agent: taskCall.callerAgent,
              tool: toolName,
              decision: "block",
              reason: String(toolInput.error ?? toolOutput?.error ?? "No result returned"),
              details: {
                callID,
                targetAgent: taskCall.targetAgent,
                durationMs,
                resolvedFrom: taskCall.resolvedFrom,
              },
            })
          } else {
            appendAuditEvent(directory, {
              kind: "delegation.completed",
              session_id: sessionID,
              agent: taskCall.callerAgent,
              tool: toolName,
              decision: "allow",
              details: {
                callID,
                targetAgent: taskCall.targetAgent,
                durationMs,
                resolvedFrom: taskCall.resolvedFrom,
              },
            })
          }
          sessionTaskCalls.delete(taskKey)
        }
      }

      if (toolInput.error) {
        const errorMsg = String(toolInput.error)

        // Terminal delegation errors must not consume retry budget or trigger recovery.
        if (errorMsg.startsWith("SELF_DELEGATION_BLOCKED:") || errorMsg.startsWith("MISSING_TARGET_AGENT:")) {
          appLog(`[ADVISORY] Terminal delegation error — not retrying: ${errorMsg.slice(0, 120)}`, "warn", sessionID)
          return
        }

        recordRecoveryAudit({
          directory,
          sessionID,
          agent,
          errorKey: `${toolName}:${errorMsg.slice(0, 100)}`,
          action: "targeted_diagnosis",
          message: `Tool ${toolName} failed: ${errorMsg.slice(0, 200)}`,
        })

        if (sessionID) {
          const retryCount = (sessionRetries.get(sessionID) ?? 0) + 1
          sessionRetries.set(sessionID, retryCount)
          if (retryCount > maxRetries) {
            const msg = `Retry budget exceeded: ${retryCount} > ${maxRetries} for session ${sessionID}`
            const govMode = resolveGovernanceMode(directory)
            recordRecoveryAudit({
              directory, sessionID, agent,
              errorKey: "retry_budget_exceeded",
              action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
              message: msg,
            })
            if (govMode === "strict") {
              throw new Error(msg)
            }
            appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
          }
        }
      }
    },

    event: async ({ event }: { event: any }) => {
      const type: string = event?.type ?? ""
      const info = event?.properties?.info ?? event?.properties?.session ?? event?.info
      const eventSessionID = info?.id ?? event?.properties?.sessionID ?? event?.properties?.info?.id ?? event?.sessionID ?? ""
      const parentID = info?.parentID ?? event?.properties?.parentID ?? undefined
      const sessionAgent = info?.agent ?? event?.properties?.agent ?? undefined

      if (eventSessionID) {
        let meta = sessionRegistry.get(eventSessionID)
        if (!meta) {
          const parentMeta = parentID ? sessionRegistry.get(parentID) : undefined
          const calculatedDepth = parentMeta ? parentMeta.depth + 1 : (parentID ? 1 : 0)
          meta = {
            sessionID: eventSessionID,
            parentID,
            agent: sessionAgent,
            depth: calculatedDepth,
          }
          sessionRegistry.set(eventSessionID, meta)
        } else {
          if (parentID && !meta.parentID) {
            meta.parentID = parentID
            const parentMeta = sessionRegistry.get(parentID)
            meta.depth = parentMeta ? parentMeta.depth + 1 : 1
          }
          if (sessionAgent && !meta.agent) {
            meta.agent = sessionAgent
          }
        }
        if (sessionAgent && sessionAgent !== "unknown") {
          sessionCallerAgents.set(eventSessionID, sessionAgent)
        }

        // ── Child session correlation (deterministic FIFO) ──────────────
        // Uses the pendingChildSlots queue to correlate child sessions
        // to the exact task call that created them, even when multiple
        // concurrent calls target the same agent.
        if (parentID && !childSessionToTask.has(eventSessionID)) {
          const effectiveTarget = sessionAgent || meta?.agent || undefined
          const { correlation, ambiguous } = dequeuePendingSlot(parentID, effectiveTarget)
          if (correlation) {
            childSessionToTask.set(eventSessionID, correlation)
          } else if (ambiguous) {
            // Cannot determine which task call this child belongs to.
            // Emit a diagnostic instead of attaching to a potentially
            // incorrect task — never delete or fail another active task.
            appendAuditEvent(directory, {
              kind: "delegation.blocked",
              session_id: parentID,
              agent: "system",
              tool: "task",
              decision: "block",
              reason: "UNRESOLVED_CHILD_CORRELATION: Multiple pending task calls match the same parent; unable to determine which one created this child session",
              details: {
                childSessionID: eventSessionID,
                parentSessionID: parentID,
                effectiveTarget: effectiveTarget ?? "unknown",
              },
            })
          }
        }
      }

      // ── Hierarchical token-budget reconciliation ─────────────────────
      // message.updated carries the assistant message with real provider
      // tokens + cost. Reconcile the reservation made at chat.message.
      const eventMeta = eventSessionID ? sessionRegistry.get(eventSessionID) : undefined
      if (tokenBudgetRuntime.isEnabled() && type === "message.updated") {
        const msgInfo = info as {
          id: string
          role?: string
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
          cost?: number
          modelID?: string
          providerID?: string
          error?: unknown
        }
        if (msgInfo?.id && msgInfo.role === "assistant") {
          try {
            const budgetCtx = {
              sessionID: eventSessionID,
              agent: sessionAgent ?? (eventSessionID ? sessionCallerAgents.get(eventSessionID) : undefined) ?? "unknown",
              parentID,
              depth: eventMeta?.depth ?? 0,
            }
            await tokenBudgetRuntime.reconcileUsage(budgetCtx, msgInfo)
          } catch (err) {
            appLog(`[token-budget] reconcile failed: ${err instanceof Error ? err.message : String(err)}`, "warn", eventSessionID)
          }
        }
      } else if (tokenBudgetRuntime.isEnabled() && (type === "session.error" || type === "session.completed")) {
        try {
          const budgetCtx = {
            sessionID: eventSessionID,
            agent: sessionAgent ?? (eventSessionID ? sessionCallerAgents.get(eventSessionID) : undefined) ?? "unknown",
            parentID,
            depth: eventMeta?.depth ?? 0,
          }
          await tokenBudgetRuntime.onSessionEnd(budgetCtx, type === "session.error" ? "session_error" : "session_completed")
        } catch (err) {
          appLog(`[token-budget] session-end release failed: ${err instanceof Error ? err.message : String(err)}`, "warn", eventSessionID)
        }
      }

      const sessionID = eventSessionID
      if (type === "session.created" || type === "session.started") {
        await sessionStartHook({ directory }, appLog)
        appendAuditEvent(directory, {
          kind: "session.started",
          session_id: sessionID,
          agent: "system",
          decision: "start",
          reason: "Session started",
        })
        if (sessionID) {
          sessionStartTimes.set(sessionID, Date.now())
        }
      } else if (type === "session.completed" || type === "session.error") {
        try {
          await sessionEventsHook({ directory }, type === "session.completed" ? "completed" : "error", sessionID)
          if (type === "session.completed") {
            appendAuditEvent(directory, {
              kind: "session.completed",
              session_id: sessionID,
              agent: "system",
              decision: "complete",
              reason: "Session completed",
            })

            if (sessionID) {
              const toolCalls = sessionToolCalls.get(sessionID) ?? 0
              const retries = sessionRetries.get(sessionID) ?? 0
              const delegations = sessionDelegations.get(sessionID) ?? 0
              const blocks = sessionBlocks.get(sessionID) ?? 0
              const warnings = sessionWarnings.get(sessionID) ?? 0
              const startTime = sessionStartTimes.get(sessionID)
              const durationMs = startTime ? Date.now() - startTime : null
              const filesChangedSet = sessionFilesChanged.get(sessionID)
              const filesChanged = filesChangedSet ? filesChangedSet.size : null

              const scorecard = generateScorecard({
                commandsRun: toolCalls,
                testsPassed: null,
                testsFailed: null,
                buildResult: null,
                typecheckResult: null,
                filesChanged,
                toolCalls,
                delegations,
                retries,
                blocks,
                warnings,
                durationMs,
                remainingFindings: null,
              })
              await appLog(`[scorecard] Session ${sessionID}: ${JSON.stringify(scorecard)}`)
            }
          } else if (type === "session.error") {
            const errorMessage = event?.properties?.error ?? event?.error ?? "Session errored"

            // ── Child session failure → delegation.failed ──────────────
            // When OpenCode's Task execution fails, tool.execute.after is NOT called.
            // The real failure path is session.error on the child session.
            // Detect child sessions by exact childSessionToTask correlation.
            const childMeta = sessionID ? sessionRegistry.get(sessionID) : undefined
            if (childMeta?.parentID) {
              const parentSessionID = childMeta.parentID
              const now = Date.now()
              const correlation = childSessionToTask.get(sessionID)

              let matchedTaskKey: string | undefined
              let matchedTaskCall: { callerAgent: string; targetAgent: string; startedAt: number; resolvedFrom: string } | undefined

              if (correlation) {
                matchedTaskKey = correlation.taskKey
                matchedTaskCall = sessionTaskCalls.get(matchedTaskKey)
              } else {
                // No correlation available — try pending queue as last resort.
                // This handles the edge case where session.error fires before
                // session.created (unusual but defensive).
                const pendingResult = dequeuePendingSlot(parentSessionID, childMeta.agent || undefined)
                if (pendingResult.correlation) {
                  matchedTaskKey = pendingResult.correlation.taskKey
                  matchedTaskCall = sessionTaskCalls.get(matchedTaskKey)
                  // Also register in childSessionToTask so subsequent events
                  // don't create a duplicate correlation
                  childSessionToTask.set(sessionID, pendingResult.correlation)
                } else if (pendingResult.ambiguous) {
                  // Cannot resolve — emit diagnostic without failing another task
                  matchedTaskKey = undefined
                  matchedTaskCall = undefined
                }
              }

              if (matchedTaskKey && matchedTaskCall) {
                const callIDFromKey = matchedTaskKey.slice(parentSessionID.length + 1)
                const durationMs = now - matchedTaskCall.startedAt
                appendAuditEvent(directory, {
                  kind: "delegation.failed",
                  session_id: parentSessionID,
                  agent: matchedTaskCall.callerAgent,
                  tool: "task",
                  decision: "block",
                  reason: String(errorMessage),
                  details: {
                    callID: callIDFromKey !== "task" ? callIDFromKey : undefined,
                    targetAgent: matchedTaskCall.targetAgent,
                    childSessionID: sessionID,
                    durationMs,
                    resolvedFrom: matchedTaskCall.resolvedFrom,
                  },
                })
                sessionTaskCalls.delete(matchedTaskKey)
                childSessionToTask.delete(sessionID)
              } else {
                // Unresolved correlation — emit diagnostic without affecting other active tasks
                appendAuditEvent(directory, {
                  kind: "delegation.failed",
                  session_id: parentSessionID,
                  agent: "system",
                  tool: "task",
                  decision: "block",
                  reason: `UNRESOLVED_CHILD_FAILURE: ${String(errorMessage)}`,
                  details: {
                    childSessionID: sessionID,
                    targetAgent: childMeta.agent,
                  },
                })
              }
            }

            appendAuditEvent(directory, {
              kind: "session.completed",
              session_id: sessionID,
              agent: "system",
              decision: "error",
              reason: "Session errored",
            })
          }
        } finally {
          if (sessionID) {
            cleanupSessionState(sessionID, loopDetector)
          }
        }
      } else if (type === "session.idle") {
        await sessionEventsHook({ directory }, "idle", sessionID)
      }
      orchestratorGuard.onEvent(event)
    },

    dispose: async () => {
      // Stop the outbox worker and run the better-harness cleanup (best-effort teardown)
      if (activeOrchestrationRuntime) {
        try {
          activeOrchestrationRuntime.outboxWorker.stop()
        } catch { /* teardown best-effort */ }
      }
      if (_betterHarnessCleanup) {
        try { _betterHarnessCleanup() } catch { /* best-effort */ }
        _betterHarnessCleanup = null
      }
    },
  }
}

export function cleanupSessionState(sessionID: string, ld?: LoopDetector): void {
  if (!sessionID) return
  sessionToolCalls.delete(sessionID)
  sessionRetries.delete(sessionID)
  sessionDelegations.delete(sessionID)
  sessionBlocks.delete(sessionID)
  sessionWarnings.delete(sessionID)
  sessionStartTimes.delete(sessionID)
  sessionFilesChanged.delete(sessionID)
  sessionCallerAgents.delete(sessionID)
  sessionRegistry.delete(sessionID)
  // ── Child session correlation cleanup ──────────────────────────
  // Remove the sessionID entry from sessionTaskCalls (used as a direct key
  // by some flows) and all taskKey entries prefixed by sessionID.
  sessionTaskCalls.delete(sessionID)
  for (const key of sessionTaskCalls.keys()) {
    if (key.startsWith(`${sessionID}:`)) {
      sessionTaskCalls.delete(key)
    }
  }
  // Remove childSessionToTask entries owned by or pointing to this session
  childSessionToTask.delete(sessionID)
  for (const [childId, corr] of childSessionToTask.entries()) {
    if (corr.parentSessionID === sessionID) {
      childSessionToTask.delete(childId)
    }
  }
  // Remove pending child slots queued by this session
  cleanupPendingSlots(sessionID)
  if (ld) {
    try { ld.clearSession(sessionID) } catch {}
  }
  try { clearWriteCounter(sessionID) } catch {}
}

export function getSessionMetricsDiagnostics(sessionID: string): {
  toolCalls: number
  retries: number
  delegations: number
  blocks: number
  warnings: number
  startTime?: number
  filesChangedCount: number
} {
  return {
    toolCalls: sessionToolCalls.get(sessionID) ?? 0,
    retries: sessionRetries.get(sessionID) ?? 0,
    delegations: sessionDelegations.get(sessionID) ?? 0,
    blocks: sessionBlocks.get(sessionID) ?? 0,
    warnings: sessionWarnings.get(sessionID) ?? 0,
    startTime: sessionStartTimes.get(sessionID),
    filesChangedCount: sessionFilesChanged.get(sessionID)?.size ?? 0,
  }
}

// ─── Production orchestration runtime accessor ───────────────────────
// Module-level holder so the runtime can be torn down via the plugin
// `dispose` hook and queried externally (Phase 8 getOrchestrationRuntime).
let activeOrchestrationRuntime: ProductionOrchestrationRuntime | null = null
export function getOrchestrationRuntime(): ProductionOrchestrationRuntime | null {
  return activeOrchestrationRuntime
}

const flowDeckPlugin = {
  id: "@heidi-dang/flowdeck",
  server: plugin,
}

export default flowDeckPlugin

export { AGENT_NAMES, createAgent } from "./agents/index"
export { validateDelegationDepth, evaluateGovernanceToolCheck } from "./services/governance-wiring"
export type { ValidateDelegationDepthOptions } from "./services/governance-wiring"
export { acquireLock, releaseLock } from "./services/async-lock"
export { runDoctor, formatReport, formatJSON } from "./doctor/doctor"
// resolveDoctorExitCode provenant du module canonique sans dépendances
export { resolveDoctorExitCode } from "./doctor/exit-code.mjs"
// Redaction utilities exported for consumers (logs, reports, doctor probes)
export { redactSecrets, containsSecrets } from "./lib/secret-redaction"
