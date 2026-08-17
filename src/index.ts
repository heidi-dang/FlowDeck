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
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import { homedir, tmpdir } from "os"

import {
  buildSelectionDiagnostics,
  detectProjectLanguages,
  getStartupRulePaths,
  selectRulePaths,
} from "./services/lazy-rule-loader"
import { LoopDetector } from "./services/loop-detector"
import { RecoverableFlowDeckBlockError, isRecoverableBlockError } from "./services/recoverable-block"

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
  configureFdxNextRuntime,
  setActiveProjectDir,
} from "./tools/fdx"
import { fdxPrMonitorTool } from "./tools/fdx-pr-monitor"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"
import { debugLogsTool } from "./tools/debug-logs"
import { heidiMemoryTool, heidiRecallTool } from "./tools/heidi-memory"
import { heidiArchiveSessionTool } from "./tools/heidi-session"
import { heidiLearningTool, heidiSkillTool } from "./tools/heidi-learning"
import { heidiAgentsTool } from "./tools/heidi-agents"
import { HeidiDelegationRuntime } from "./services/heidi-delegation-runtime"
import { heidiPipelineTool, heidiSchedulerTool } from "./tools/heidi-controls"
import { configureHeidiPipelineTools } from "./services/heidi-runtime-controls"
import { HeidiScheduler, HeidiSchedulerWorker } from "./services/heidi-runtime-controls"
import { HeidiLearningRuntime } from "./services/heidi-learning-runtime"
import { HeidiPersistentAgentStore } from "./services/heidi-persistent-agent"
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
import { validateHistorySafety, sanitizeReasoningOnlyHistory, detectNoVisibleOutputCompletion, assertProviderReplayShape } from "./services/provider-history-safety"
import {
  REPLAY_CONTINUATION_PROMPT,
  MAX_AUTO_CONTINUATIONS_PER_SESSION,
  classifyProviderError,
  buildContinuationSignature,
  decideStage1Continuation,
  decideStage2Continuation,
  type SessionRecoveryState,
} from "./services/reasoning-recovery"
import { updateWatchdogState, clearWatchdogState, getAllWatchdogStates, clearAllWatchdogStates } from "./services/heidi-watchdog"
import { initializeDatabase, closeAllConnections } from "./orchestration/persistence/index"
import { createProductionOrchestrationRuntime, type ProductionOrchestrationRuntime } from "./orchestration/composition"
import { runShadowAssessment } from "./orchestration/routing/shadow"
import { createEnforceRun } from "./orchestration/routing/enforce-run"
import { RunStatus } from "./orchestration/types/runs"
import { OpenCodeWorkstreamExecutor } from "./orchestration/execution/opencode-executor"
import { FdxWorkspaceIndex } from "./services/fdx-index"
import { FdxDaemon } from "./services/fdx-daemon"
import { execFileSync } from "node:child_process"
import {
  getExecutingRuntimeIdentity,
  recordRuntimeSelfReport,
} from "./services/runtime-identity"

// ─── Session budget tracking ──────────────────────────────────────────────
const sessionToolCalls = new Map<string, number>()
const sessionRetries = new Map<string, number>()
const sessionDelegations = new Map<string, number>()
const sessionBlocks = new Map<string, number>()
const sessionRecoverableBlocks = new Map<string, RecoverableFlowDeckBlockError>()
const sessionReasoningRecoveryRegistry = new Map<string, Set<string>>()
const sessionAutoContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sessionRecoveryState = new Map<string, SessionRecoveryState>()
const sessionContinuationCount = new Map<string, number>()
const sessionWarnings = new Map<string, number>()
const sessionStartTimes = new Map<string, number>()
const sessionActiveTools = new Map<string, number>()
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
const flowdeckPackageVersion = JSON.parse(
  readFileSync(join(__dir, "..", "package.json"), "utf-8"),
).version as string

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

/**
 * Deterministic writable orchestration database selection.
 *
 * The project-root location (<directory>/.flowdeck/flowdeck.db) is preferred.
 * When that directory cannot be created/opened for writing — e.g. the global
 * instance boots with directory="/" where no write is permitted — fall back to
 * the established writable FlowDeck state location under the user home, then to
 * the system temp directory. The chosen path is always observable via the log;
 * real database errors are never hidden.
 */
function resolveOrchestrationDbPath(
  directory: string,
  log: (msg: string, level?: "debug" | "info" | "warn" | "error") => Promise<void>,
): string {
  const candidates = [
    join(directory, ".flowdeck", "flowdeck.db"),
    join(homedir(), ".flowdeck", "flowdeck.db"),
    join(tmpdir(), "flowdeck", "flowdeck.db"),
  ]
  for (const candidate of candidates) {
    const dir = dirname(candidate)
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.flowdeck-probe-${process.pid}`)
      writeFileSync(probe, "writable")
      rmSync(probe, { force: true })
    } catch {
      void log(`[orchestration] database directory not writable: ${dir}`, "warn")
      continue
    }
    return candidate
  }
  // All candidates unwritable: return the project path and let initializeDatabase
  // raise the real underlying error — do not hide it.
  return candidates[0]
}

const plugin: Plugin = async ({ directory, client }) => {
  let isDisposed = false
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
  let handleEvent: (args: { event: any }) => Promise<void> = async () => {}
  /** Bounded reasoning-only auto-continuation: exactly one prompt per scheduled stage, 50ms debounce. */
  const scheduleReasoningContinuation = (targetSessionID: string): void => {
    const sessionApi = (client as any)?.session
    if (!sessionApi?.prompt && !sessionApi?.promptAsync) return
    const promptFn = sessionApi.promptAsync ? sessionApi.promptAsync.bind(sessionApi) : sessionApi.prompt.bind(sessionApi)
    updateWatchdogState(targetSessionID, { isPendingContinuation: true })
    const handleContinuationFailure = (err: Error, sessionId: string) => {
      if (isDisposed) return
      appLog(`[heidi] Reasoning continuation prompt rejected: ${err.message}`, "error", sessionId)
      updateWatchdogState(sessionId, { isPendingContinuation: false })
      client.app.log({ body: { service: "flowdeck", level: "error", message: `Reasoning continuation rejected: ${err.message}`, extra: { sessionID: sessionId } } }).catch(()=>{})
      handleEvent({ event: { type: "session.error", properties: { sessionID: sessionId, error: err.message, info: { id: sessionId, role: "assistant", error: err.message } } } })
    }
    const timer = setTimeout(() => {
      if (isDisposed) return
      sessionAutoContinuationTimers.delete(targetSessionID)
      let result: unknown
      try {
        result = promptFn({
          path: { id: targetSessionID },
          body: {
            parts: [{ type: "text", text: REPLAY_CONTINUATION_PROMPT }],
          },
        })
      } catch (err) {
        // Synchronous session API failure: treat as a rejected continuation.
        handleContinuationFailure(err as Error, targetSessionID)
        return
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        ;(result as Promise<unknown>)
          .then(() => updateWatchdogState(targetSessionID, { isPendingContinuation: false }))
          .catch((err: Error) => handleContinuationFailure(err, targetSessionID))
      } else {
        // Session API returned synchronously (no promise): continuation was submitted.
        updateWatchdogState(targetSessionID, { isPendingContinuation: false })
      }
    }, 50)
    sessionAutoContinuationTimers.set(targetSessionID, timer)
  }
  recordRuntimeSelfReport(getExecutingRuntimeIdentity(import.meta.url), directory)
  let fdxWorkspaceIndex: FdxWorkspaceIndex | undefined
  let fdxDaemon: FdxDaemon | undefined
  let fdxDaemonSocketPath: string | undefined
  try {
    fdxWorkspaceIndex = new FdxWorkspaceIndex({
      stateFile: join(directory, ".flowdeck", "fdx-index.json"),
      maxFiles: 10_000,
      maxFileBytes: 2_000_000,
      maxWorkspaces: 32,
    })
    if (process.env.FLOWDECK_FDX_DAEMON === "on") {
      const socketPath = join(directory, ".flowdeck", "fdx.sock")
      const daemon = new FdxDaemon({ socketPath, workspaceRoot: directory, index: fdxWorkspaceIndex })
      try {
        await daemon.start()
        fdxDaemon = daemon
        fdxDaemonSocketPath = socketPath
      } catch {
        await daemon.stop()
      }
    }
    configureFdxNextRuntime({ workspace: directory, index: fdxWorkspaceIndex, daemonSocketPath: fdxDaemonSocketPath })
  } catch {
    // The persistent index is optional. Native FDX and the existing
    // TypeScript fallbacks remain the operational path if it cannot load.
    configureFdxNextRuntime()
  }
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
  const maxDelegations = flowdeckConfig.governance?.delegationBudget?.maxDelegations ?? 100
  const maxDepth = flowdeckConfig.governance?.delegationBudget?.maxDepth ?? 1

  const { mcps } = buildFlowDeckMcpsWithMeta()

  configureHeidiPipelineTools({
    "fdx-search": fdxSearchTool,
    "fdx-read": fdxReadTool,
    "fdx-impact": fdxImpactTool,
    "fdx-context": fdxContextTool,
    "fdx-outline": fdxOutlineTool,
  } as unknown as Record<string, { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown> }>)

  // --- Better Harness integration using shared graph ------------------------
  let betterHarnessRuntime: HarnessRuntime | null = null
  let betterHarnessServer: HarnessHttpServer | null = null
  let betterHarnessSseManager: SseManager | null = null
  let _betterHarnessCleanup: (() => void) | null = null
  let schedulerTimer: ReturnType<typeof setInterval> | undefined

  let _watchdogTimer: ReturnType<typeof setInterval> | undefined

  _watchdogTimer = setInterval(() => {
    if (isDisposed) return
    const now = Date.now()
    const WATCHDOG_TIMEOUT_MS = 60000 // 60 seconds
    const states = getAllWatchdogStates()
    for (const state of states) {
      if (!state.hasUnresolvedTask || state.recoveryExhausted) continue
      if (state.isPendingProvider || state.isPendingTool || state.isPendingChild || state.isPendingContinuation || state.isPendingUser) continue
      if (now - state.lastProgressAt > WATCHDOG_TIMEOUT_MS) {
        appLog(`[watchdog] Stalled session detected: ${state.sessionID}. No activity for ${WATCHDOG_TIMEOUT_MS}ms. Attempting semantic recovery.`, "warn", state.sessionID).catch(()=>{})
        if (state.recoveryCount < MAX_AUTO_CONTINUATIONS_PER_SESSION) {
           updateWatchdogState(state.sessionID, { recoveryCount: state.recoveryCount + 1 })
           const sessionApi = (client as any)?.session
           if (sessionApi?.prompt || sessionApi?.promptAsync) {
             const promptFn = sessionApi.promptAsync ? sessionApi.promptAsync.bind(sessionApi) : sessionApi.prompt.bind(sessionApi)
             let recovered: unknown
             try {
               recovered = promptFn({ path: { id: state.sessionID }, body: { parts: [{ type: "text", text: "The session appears stalled without completing the task. Please continue your work or explain what you are waiting for." }] } })
             } catch {
               // A sync session API failure must never escape the watchdog timer.
             }
             if (recovered && typeof (recovered as Promise<unknown>).then === "function") {
               ;(recovered as Promise<unknown>).catch(() => {})
             }
           }
        } else {
           appLog(`[watchdog] Stalled session ${state.sessionID} exhausted watchdog recovery budget.`, "error", state.sessionID).catch(()=>{})
           updateWatchdogState(state.sessionID, { recoveryExhausted: true })
        }
      }
    }
  }, 10000)


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
    const dbPath = resolveOrchestrationDbPath(directory, appLog)
    const { db } = initializeDatabase({ path: dbPath })
    activeOrchestrationRuntime = createProductionOrchestrationRuntime(db, { repositoryPath: directory, worktreeRoot: join(directory, ".flowdeck", "worktrees"), routingMode: () => flowdeckConfig.routing?.enabled ? (flowdeckConfig.routing.mode ?? "shadow") : "off", budgetState: () => tokenBudgetRuntime.getRunSnapshot(), fdxHealth: () => fdxWorkspaceIndex ? { available: true, ...fdxWorkspaceIndex.health(), daemon: Boolean(fdxDaemon) } : { available: false, daemon: false } })
    tokenBudgetRuntime.setMetrics(activeOrchestrationRuntime.metrics)
    if (fdxWorkspaceIndex) configureFdxNextRuntime({ workspace: directory, index: fdxWorkspaceIndex, daemonSocketPath: fdxDaemonSocketPath, metrics: activeOrchestrationRuntime.metrics })
    activeOrchestrationRuntime.worktreeExecutionService?.setBudgetCoordinator({
      open: workstream => tokenBudgetRuntime.openWorkstreamBudget(workstream),
      redistribute: (workstream, amount, reason, sourceReservationId) => tokenBudgetRuntime.redistributeWorkstream(workstream, amount, reason, sourceReservationId),
    })
    appLog("[orchestration] Production orchestration runtime initialized successfully")
    if (flowdeckConfig.heidi?.scheduler?.enabled !== false) {
      const scheduler = new HeidiScheduler(db)
      const sessionApi = (client as unknown as { session?: { create?: (input: { title: string; directory?: string }) => Promise<{ data?: { id?: string } }>; prompt?: (input: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => Promise<unknown> } }).session
      const worker = new HeidiSchedulerWorker(scheduler, async job => {
        if (!sessionApi?.create || !sessionApi.prompt) throw new Error("OpenCode session execution API unavailable")
        const created = await sessionApi.create({ title: `Heidi scheduled: ${job.id}`, directory: job.workspace })
        const sessionId = created.data?.id
        if (!sessionId) throw new Error("OpenCode did not return a scheduled session id")
        await sessionApi.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text: job.prompt }] } })
      })
      const interval = Math.max(5_000, flowdeckConfig.heidi?.scheduler?.pollIntervalMs ?? 30_000)
      schedulerTimer = setInterval(() => { if (isDisposed) return; void worker.runOnce().catch(error => { void appLog(`[scheduler] worker failure: ${error instanceof Error ? error.message : String(error)}`, "warn") }) }, interval)
    }
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

      // Routing remains opt-in. Shadow mode is observational. Enforce mode
      // uses a durable orchestration run as the execution-plan identity, then
      // dispatches only through the injected isolated-workstream runtime. The
      // normal OpenCode session remains the model/provider authority.
      const routingMode = flowdeckConfig.routing?.enabled ? (flowdeckConfig.routing.mode ?? "shadow") : "off"
      const taskText = typeof output.message?.content === "string" ? output.message.content : ""
      if ((routingMode === "shadow" || routingMode === "enforce") && taskText.trim()) {
        let sourceSha = process.env.FLOWDECK_SOURCE_SHA
        if (!sourceSha) {
          try { sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim() } catch { sourceSha = "0000000000000000000000000000000000000000" }
        }
        let enforceRun: Awaited<ReturnType<typeof createEnforceRun>> | undefined
        if (routingMode === "enforce" && activeOrchestrationRuntime) {
          try {
            enforceRun = await createEnforceRun(activeOrchestrationRuntime.services.runService, sessionID, agent, sourceSha)
          } catch (error) {
            await appLog(`[routing] enforce run creation failed closed: ${error instanceof Error ? error.message : String(error)}`, "warn", sessionID)
          }
        }
        const comparison = runShadowAssessment({ runId: (enforceRun?.id ?? sessionID) || "sessionless", sourceSha, task: taskText }, "existing", routingMode, activeOrchestrationRuntime?.routingDecisionRepository, activeOrchestrationRuntime?.metrics)
        if (routingMode === "enforce" && enforceRun && comparison.decision && activeOrchestrationRuntime) {
          const activation = await activeOrchestrationRuntime.authoritativeRouting.activateAndExecute(comparison.decision, sourceSha, {
            milestone1: Boolean(comparison.decision.finalized),
            executionPlanner: Boolean(activeOrchestrationRuntime.worktreeExecutionService),
            adaptiveBudget: tokenBudgetRuntime.isEnabled(),
            performanceIntelligence: Boolean(activeOrchestrationRuntime.performanceRepository),
            determinism: comparison.decision.policyVersion.length > 0 && comparison.decision.assessment.classifierVersion.length > 0,
            safety: Boolean(activeOrchestrationRuntime.worktreeManager && activeOrchestrationRuntime.integrationService),
            modelAuthority: true,
            budgetAuthority: tokenBudgetRuntime.isEnabled(),
            completionAuthority: Boolean(activeOrchestrationRuntime.services.completionService),
          }, new OpenCodeWorkstreamExecutor(client))
          if (activation.fallback) {
            await activeOrchestrationRuntime.services.runService.updateRun(enforceRun.id, { status: RunStatus.FAILED, error: activation.reason })
            await appLog(`[routing] enforce fallback: ${activation.reason}`, "warn", sessionID)
          } else {
            const failed = activation.execution.failed.length > 0 || activation.execution.blocked.length > 0
            await activeOrchestrationRuntime.services.runService.updateRun(enforceRun.id, { status: failed ? RunStatus.FAILED : RunStatus.COMPLETED, error: failed ? "ONE_OR_MORE_WORKSTREAMS_FAILED" : undefined })
            await appLog(`[routing] enforce plan ${activation.planId} executed: ${activation.execution.succeeded.length} integrated, ${activation.execution.failed.length} failed, ${activation.execution.blocked.length} blocked; selected model/provider authority remains unchanged`, "info", sessionID)
          }
        } else if (routingMode === "enforce" && comparison.error) {
          await appLog(`[routing] enforce assessment failed closed: ${comparison.error}`, "warn", sessionID)
        }
      }

      const variant = input.variant
      const pkgVersion = flowdeckPackageVersion
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

    },

    "experimental.chat.messages.transform": async (input, output) => {
      const sessionID = output.messages[0]?.info?.sessionID ?? (input as any)?.sessionID ?? ""
      const sampleMsg = output.messages.find(m => m.info?.sessionID) ?? output.messages[0]
      const realSessionID = sampleMsg?.info?.sessionID || sessionID || "default-session"
      const realParentID = (sampleMsg?.info as any)?.parentID

      // 1. Validate history before sanitation
      const rawDiag = validateHistorySafety(output.messages)
      if (!rawDiag.safe) {
        await client.app.log({ body: { service: "flowdeck", level: "warn", message: `[provider-history] Raw history contains safety issues: ${rawDiag.issues.join(", ")}`, extra: { sessionID: realSessionID } } }).catch(() => {})
      }

      // 2. Sanitize reasoning-only turns to prevent provider replay HTTP 400 INVALID_ARGUMENT.
      //    IMPORTANT: opencode passes the SAME messages array reference into this
      //    handler and into its provider serialization (toModelMessagesEffect(C)).
      //    Reassigning output.messages only changes the wrapper property and is
      //    silently ignored by the provider path. We therefore build the sanitized
      //    array and then MUTATE the shared array in place (clear + refill).
      const sanitized = sanitizeReasoningOnlyHistory(output.messages)

      // 3. Compact intermediate conversation turns when token footprint exceeds threshold
      const turnMappedMessages = sanitized.map(m => {
        let content = ""
        for (const p of m.parts) {
          if (p.type === "text" && p.text) content += p.text + "\n"
        }
        return {
          role: m.info.role,
          content: content.trim() || "[hidden or structured content]",
          originalMessage: m
        }
      })
      
      const tokenConfig = tokenBudgetRuntime.getConfig()
      const compactResult = compactConversationContext({
        messages: turnMappedMessages,
        thresholdTokens: tokenConfig.compactThresholdTokens,
        sessionID: realSessionID,
      })
      
      let finalMessages: typeof output.messages = sanitized
      if (compactResult.compacted) {
        const newMessages: typeof output.messages = []
        for (let i = 0; i < compactResult.messages.length; i++) {
          const m = compactResult.messages[i]
          if (m.originalMessage) {
            newMessages.push(m.originalMessage)
          } else {
            const role = m.role === "user" || m.role === "assistant" ? m.role : "user"
            const msgId = `msg_compact_${realSessionID}_${i}`
            newMessages.push({
              info: {
                id: msgId,
                sessionID: realSessionID,
                role: role,
                time: { created: Date.now() },
                mode: (sampleMsg?.info as any)?.mode ?? "chat",
                parentID: realParentID,
                tools: []
              } as any,
              parts: [{ type: "text", text: m.content, id: `p-${msgId}`, sessionID: realSessionID, messageID: msgId }] as any
            })
          }
        }
        finalMessages = newMessages
      }

      // 4. Mutate the SHARED array in place so opencode's provider serialization
      //    (toModelMessagesEffect, reading the same reference) sees the sanitized
      //    history. Do not reassign output.messages.
      output.messages.length = 0
      for (const m of finalMessages) output.messages.push(m)

      // 4. Assert the provider-replay shape actually handed to the provider.
      //    This is the closest safe FlowDeck boundary to the provider request:
      //    after sanitation the history must contain no reasoning parts, no
      //    empty/error assistant turns, no empty content, no unresolved or
      //    duplicate tool calls.
      const finalDiag = assertProviderReplayShape(output.messages)
      if (!finalDiag.safe) {
        await client.app.log({ body: { service: "flowdeck", level: "warn", message: `[provider-history] Sanitized history still unsafe for provider replay: ${finalDiag.issues.join(", ")}`, extra: { sessionID: realSessionID } } }).catch(() => {})
        // Record diagnostic
        appendAuditEvent(directory, {
          kind: "guard.warn",
          session_id: realSessionID,
          agent: "system",
          decision: "warn",
          reason: "Unsafe provider replay shape after sanitation",
          details: { issues: finalDiag.issues },
        })
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID ?? ""
      const sessionMeta = sessionID ? sessionRegistry.get(sessionID) : undefined
      const agent = sessionMeta?.agent ?? "unknown"
      const runtimeCfg = resolveRuntimeAgentConfig(flowdeckConfig, effectiveDefaultAgent)
      
      const combinedSystem = output.system.join("\n")
      const markedSystem = applyIdentityMarker(
        combinedSystem,
        agent,
        runtimeCfg.expectedAgent ?? "heidi"
      )
      
      output.system = [markedSystem]
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
      "heidi-memory": heidiMemoryTool,
      "heidi-recall": heidiRecallTool,
      "heidi-archive-session": heidiArchiveSessionTool,
      "heidi-learning": heidiLearningTool,
      "heidi-skill": heidiSkillTool,
      "heidi-tool-pipeline": heidiPipelineTool,
      "heidi-scheduler": heidiSchedulerTool,
      "heidi-agents": heidiAgentsTool,
    "fdx-pr-monitor": fdxPrMonitorTool,
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      let isToolTracked = false;
      const sessionID = toolInput.sessionID ?? "";
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
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
          if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
        throw new Error("TASK_CALLER_UNRESOLVED: Unable to resolve calling agent identity for Task execution")
        }
      }

      const agent = resolvedCaller || "heidi"

      // ── 0. Tool call budget tracking ─────────────────────────────────
      if (sessionID) {
        const callCount = (sessionToolCalls.get(sessionID) ?? 0) + 1
        const activeCount = (sessionActiveTools.get(sessionID) ?? 0) + 1
        sessionActiveTools.set(sessionID, activeCount)
        updateWatchdogState(sessionID, { isPendingTool: activeCount > 0 })
        isToolTracked = true;
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
            if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
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
        if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
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
            if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
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
              if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
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
          try {
            const delegationDb = initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db
            new HeidiDelegationRuntime(delegationDb).queued({ childId: taskKey, parentSessionId: sessionID, specialist: targetAgent, goal: String(rawArgs.prompt ?? "") })
          } catch (error) { await appLog(`[delegation] projection queue failed: ${error instanceof Error ? error.message : String(error)}`, "warn", sessionID) }

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
          if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
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
      try {
      const loop = loopDetector.checkBefore(
        toolName,
        rawArgs,
        sessionID,
      )
      if (loop.action === "block") {
        if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
        throw new RecoverableFlowDeckBlockError({
          subsystem: "loop_detector",
          code: "LOOP_GUARD_REPEATED_ACTION",
          tool: toolName,
          sessionID,
          agent,
          reason: loop.escalationMessage,
          recoverable: true,
          suggestedActions: [
            "Use the output from the previous call",
            "Inspect a different file or pattern",
            "Proceed to the next task step",
          ],
        })
      }
      if (loop.action === "warn") appLog(loop.message, "warn", sessionID)
      } catch (err: any) {
        if (isRecoverableBlockError(err) && sessionID) {
          sessionRecoverableBlocks.set(sessionID, err)
        }
        if (isToolTracked && sessionID) {
          const c = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1);
          sessionActiveTools.set(sessionID, c);
          updateWatchdogState(sessionID, { isPendingTool: c > 0 });
        }
        throw err
      }
    },

    "tool.execute.after": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const callID = toolInput.callID ?? ""
      const agent = sessionCallerAgents.get(sessionID) ?? toolInput.agent ?? "unknown"
      const rawArgs = toolOutput?.args ?? toolInput?.args ?? {}
      appLog(`[tool] done tool=${toolName} session=${sessionID}`)
      if (sessionID) {
        const activeCount = Math.max(0, (sessionActiveTools.get(sessionID) ?? 0) - 1)
        sessionActiveTools.set(sessionID, activeCount)
        updateWatchdogState(sessionID, { isPendingTool: activeCount > 0 })
      }

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
          try { new HeidiDelegationRuntime(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db).transition(taskKey, hasError ? "failed" : "completed", { summary: hasError ? undefined : String(toolOutput?.output ?? toolOutput?.result ?? "Delegated task completed").slice(0, 1000), error: hasError ? String(toolInput.error ?? toolOutput?.error ?? "No result returned") : undefined, toolCalls: sessionToolCalls.get(sessionID) ?? 0 }) } catch { /* projection is secondary */ }
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

    event: handleEvent = async ({ event }: { event: any }) => {
      const type: string = event?.type ?? ""
      const info = event?.properties?.info ?? event?.properties?.session ?? event?.info
      const eventSessionID = info?.sessionID ?? event?.properties?.sessionID ?? event?.properties?.info?.sessionID ?? info?.id ?? event?.sessionID ?? ""
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
          updateWatchdogState(eventSessionID, { hasUnresolvedTask: true })
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
            try { new HeidiDelegationRuntime(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db).transition(correlation.taskKey, "running") } catch { /* projection is secondary */ }
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
      if (type === "session.started" || type === "message.updated" || type === "chat.message") {
        updateWatchdogState(sessionID, { lastProgressAt: Date.now() })
      }

      // ── Reasoning-only completion detection, bounded auto-continuation ───
      // Exactly-once semantics per completion signature: duplicate message.updated /
      // session.idle deliveries of the SAME completion are circuit-broken; a
      // failed stage-1 continuation may promote to one bounded stage-2 recovery;
      // after that recovery is exhausted the session gets a structured, visible
      // failure record instead of silently idling.
      if ((type === "message.updated" || type === "session.idle") && eventSessionID) {
        const msgInfo = info as any
        if (msgInfo?.id && msgInfo.role === "assistant") {
          let parts = event?.properties?.parts ?? event?.parts
          if (!parts && (client as any)?.session?.messages) {
             try {
               const hist = await (client as any).session.messages({ path: { id: eventSessionID } })
               const msgs = Array.isArray(hist) ? hist : (hist?.data ?? hist?.messages ?? [])
               const latest = msgs.find((m: any) => m?.info?.id === msgInfo.id)
               if (latest?.parts) parts = latest.parts
             } catch {}
          }

          // A session that produced visible output or tool execution after
          // recovery is healthy again — clear the recovery state.
          if (parts && sessionRecoveryState.has(eventSessionID) && !msgInfo.error) {
            const hasOutput = parts.some((p: any) => (p.type === "text" && p.text?.trim()) || p.type === "tool")
            if (hasOutput) sessionRecoveryState.delete(eventSessionID)
          }

          // ── Failed continuation → bounded stage-2 recovery ───────────────
          if (msgInfo.error && type === "message.updated") {
            const st = sessionRecoveryState.get(eventSessionID)
            const errText = msgInfo.error instanceof Error ? msgInfo.error.message : String(msgInfo.error ?? "")
            if (st) {
              const errorClass = classifyProviderError(msgInfo.error)
              let circuitBreaker = sessionReasoningRecoveryRegistry.get(eventSessionID)
              if (!circuitBreaker) {
                circuitBreaker = new Set<string>()
                sessionReasoningRecoveryRegistry.set(eventSessionID, circuitBreaker)
              }
              const sig2 = buildContinuationSignature({
                sessionID: eventSessionID,
                messageID: st.malformedMessageId,
                provider: st.provider ?? "unknown",
                model: st.model ?? "unknown",
                stage: 2,
              })
              const count = sessionContinuationCount.get(eventSessionID) ?? 0
              const decision = decideStage2Continuation({
                sessionID: eventSessionID,
                state: st,
                errorClass,
                signature: sig2,
                breaker: circuitBreaker,
                continuationCount: count,
              })
              if (decision.action === "schedule" && decision.stage) {
                sessionRecoveryState.set(eventSessionID, { ...st, stage: decision.stage })
                sessionContinuationCount.set(eventSessionID, count + 1)
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "recover_stage2",
                  reason: "Stage-1 continuation failed with provider replay error; scheduling bounded stage-2 recovery",
                  details: { messageID: msgInfo.id, errorClass, error: errText.slice(0, 500) },
                })
                appLog(`[heidi] Stage-1 reasoning continuation failed (${errorClass}); scheduling bounded stage-2 recovery for session ${eventSessionID}`, "warn", eventSessionID)
                scheduleReasoningContinuation(eventSessionID)
              } else if (decision.action === "circuit_break") {
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "circuit_break",
                  reason: "Duplicate stage-2 recovery event suppressed",
                  details: { messageID: msgInfo.id },
                })
              } else if (decision.action === "cap_reached") {
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "cap_reached",
                  reason: "Automatic continuation budget exhausted; no further recovery",
                  details: { messageID: msgInfo.id, max: MAX_AUTO_CONTINUATIONS_PER_SESSION },
                })
              } else if (errorClass === "cancelled") {
                sessionRecoveryState.delete(eventSessionID)
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "cancelled",
                  reason: "Continuation cancelled; recovery stopped",
                  details: { messageID: msgInfo.id },
                })
                appLog(`[heidi] Reasoning continuation cancelled for session ${eventSessionID}; no further recovery`, "info", eventSessionID)
              } else if (st.stage === 2) {
                sessionRecoveryState.delete(eventSessionID)
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "exhausted",
                  reason: "Bounded stage-2 recovery failed; no further auto-continuation",
                  details: { messageID: msgInfo.id, errorClass, error: errText.slice(0, 500) },
                })
                appLog(`[heidi] Reasoning recovery exhausted for session ${eventSessionID}: ${errText.slice(0, 300)} — no further auto-continuation; session remains usable`, "warn", eventSessionID)
              } else {
                sessionRecoveryState.delete(eventSessionID)
                appLog(`[heidi] Stage-1 reasoning continuation failed with non-replay error (${errorClass}); recovery stopped for session ${eventSessionID}`, "info", eventSessionID)
              }
            }
          } else if (parts) {
            const { isMalformed, diagnostics } = detectNoVisibleOutputCompletion({ info: msgInfo, parts })
            if (isMalformed && diagnostics) {
              const provider = diagnostics.provider ?? "unknown"
              const model = diagnostics.model ?? "unknown"
              const messageId = diagnostics.messageID ?? "latest"
              const sig = buildContinuationSignature({ sessionID: eventSessionID, messageID: messageId, provider, model, stage: 1 })
              let circuitBreaker = sessionReasoningRecoveryRegistry.get(eventSessionID)
              if (!circuitBreaker) {
                circuitBreaker = new Set<string>()
                sessionReasoningRecoveryRegistry.set(eventSessionID, circuitBreaker)
              }
              const count = sessionContinuationCount.get(eventSessionID) ?? 0
              const decision = decideStage1Continuation({ sessionID: eventSessionID, signature: sig, breaker: circuitBreaker, continuationCount: count })
              if (decision.action === "circuit_break") {
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "circuit_break",
                  reason: "Repeated reasoning-only completion signature detected; auto-continuation suppressed",
                  details: diagnostics as unknown as Record<string, unknown>,
                })
                appLog(`[heidi] Reasoning-only circuit breaker fired for session ${eventSessionID}`, "warn", eventSessionID)
              } else if (decision.action === "cap_reached") {
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "cap_reached",
                  reason: "Automatic continuation budget exhausted for session",
                  details: { ...(diagnostics as unknown as Record<string, unknown>), max: MAX_AUTO_CONTINUATIONS_PER_SESSION },
                })
                appLog(`[heidi] Automatic continuation budget exhausted for session ${eventSessionID} (max ${MAX_AUTO_CONTINUATIONS_PER_SESSION})`, "warn", eventSessionID)
              } else if (decision.action === "schedule" && decision.stage) {
                sessionRecoveryState.set(eventSessionID, {
                  malformedMessageId: messageId,
                  stage: decision.stage,
                  provider,
                  model,
                  scheduledAt: Date.now(),
                })
                sessionContinuationCount.set(eventSessionID, count + 1)
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "continue",
                  reason: "Reasoning-only completion detected; triggering controlled auto-continuation",
                  details: diagnostics as unknown as Record<string, unknown>,
                })
                appLog(`[heidi] Triggering reasoning-only auto-continuation for session ${eventSessionID}`, "warn", eventSessionID)
                scheduleReasoningContinuation(eventSessionID)
              }
            }
          }
        }
      }

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
            updateWatchdogState(sessionID, { hasUnresolvedTask: false })

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
              try {
                const learning = new HeidiLearningRuntime(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db)
                const review = learning.reviewCompletion({
                  completionKey: `session:${sessionID}`,
                  sessionId: sessionID,
                  repository: directory,
                  verified: blocks === 0 && warnings === 0 && toolCalls > 0,
                  summary: `Verified FlowDeck session completed with ${toolCalls} tool calls, ${delegations} delegations, ${retries} retries, and ${filesChanged ?? 0} changed files.`,
                  evidence: [`scorecard:${JSON.stringify(scorecard).slice(0, 1000)}`],
                  policy: flowdeckConfig.heidi?.learning?.reviewPolicy ?? "review",
                })
                try {
                  const archive = new HeidiPersistentAgentStore(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db)
                  archive.archiveSession(sessionID, [{ role: "assistant", content: `Verified completion: ${review.status}. ${JSON.stringify(scorecard)}`, toolSummary: "completion scorecard" }], { repository: directory, agent: "heidi" })
                } catch (archiveError) { await appLog(`[session-archive] failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`, "warn", sessionID) }
                await appLog(`[learning] completion review ${review.status}`, "info", sessionID)
              } catch (error) {
                await appLog(`[learning] completion review failed: ${error instanceof Error ? error.message : String(error)}`, "warn", sessionID)
              }
            }
          } else if (type === "session.error") {
            const errorMessage = event?.properties?.error ?? event?.error ?? "Session errored"
            updateWatchdogState(sessionID, { hasUnresolvedTask: false })

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
                try { new HeidiDelegationRuntime(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db).transition(matchedTaskKey, "failed", { error: String(errorMessage) }) } catch { /* projection is secondary */ }
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
      isDisposed = true
      
      sessionTaskCalls.clear()
      childSessionToTask.clear()
      pendingChildSlots.clear()
      sessionRegistry.clear()
      sessionCallerAgents.clear()
      sessionReasoningRecoveryRegistry.clear()
      sessionRecoveryState.clear()
      sessionContinuationCount.clear()
      sessionActiveTools.clear()
      sessionToolCalls.clear()
      sessionRetries.clear()
      sessionDelegations.clear()
      sessionBlocks.clear()
      sessionRecoverableBlocks.clear()
      sessionWarnings.clear()
      sessionStartTimes.clear()
      sessionFilesChanged.clear()
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
      if (fdxDaemon) {
        try { await fdxDaemon.stop() } catch { /* optional daemon teardown */ }
        fdxDaemon = undefined
      }
      configureFdxNextRuntime()
      if (_watchdogTimer) clearInterval(_watchdogTimer)
      for (const timer of sessionAutoContinuationTimers.values()) {
        clearTimeout(timer)
      }
      sessionAutoContinuationTimers.clear()
      clearAllWatchdogStates()
      if (schedulerTimer) clearInterval(schedulerTimer)
      // Close SQLite connections so Windows file locks are released
      try { closeAllConnections() } catch { /* best-effort */ }
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
  sessionActiveTools.delete(sessionID)
  clearWatchdogState(sessionID)
  sessionCallerAgents.delete(sessionID)
  sessionReasoningRecoveryRegistry.delete(sessionID)
  sessionRecoveryState.delete(sessionID)
  sessionContinuationCount.delete(sessionID)
  const timer = sessionAutoContinuationTimers.get(sessionID)
  if (timer) clearTimeout(timer)
  sessionAutoContinuationTimers.delete(sessionID)
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
export {
  getExecutingRuntimeIdentity,
  recordRuntimeSelfReport,
  readRuntimeSelfReport,
  isRuntimeRecordFresh,
} from "./services/runtime-identity"
export type { FlowDeckRuntimeIdentity } from "./services/runtime-identity"
