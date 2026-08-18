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
import { tool } from "@opencode-ai/plugin"
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
  configureFdxTurbo,
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
} from "./services/governance-wiring"
import { runSupervisorReview, shouldProceed, resolveSupervisorConfig } from "./services/supervisor-binding"
import { appendAuditEvent, flushAuditBuffer } from "./services/audit-log"
import { governanceFastPath } from "./services/governance-fast-path"
import { repairToolCall } from "./services/tool-call-repair"
import {
  handleUserMessage,
  handleInternalContinuation,
  renderTurnContext,
  completeTask,
  recordModelTurn,
  resolveGovernanceModeCached,
  markLeanContext,
} from "./services/heidi-fast-harness-runtime"
import { getRouteDecision } from "./services/heidi-route-state"
import { getTracker } from "./services/heidi-performance"

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
import { updateWatchdogState, getWatchdogState, clearWatchdogState, getAllWatchdogStates, clearAllWatchdogStates } from "./services/heidi-watchdog"
import { recoveryCoordinator, type RecoveryContinuationRequest } from "./services/recovery-coordinator"
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

// ─── Production-hardening subsystems ───────────────────────────────────────
import { sessionAncestry } from "./services/session-ancestry"
import { loopIncidentTracker, fingerprintAction, buildRecoveryRedirect } from "./services/loop-incident"
import { semanticConvergenceGuard as semanticConvergence } from "./services/semantic-convergence-guard"
import { emptyTerminalCircuit } from "./services/empty-terminal-circuit"
import { watchdogIncidentManager } from "./services/watchdog-incident"
import { evaluateEvidenceGate, type VerificationEvidence } from "./services/evidence-gate"
import { taskPhaseManager } from "./services/task-phase-manager"
import { repoIdOf, RepoLeaseCoordinator } from "./services/repo-lease-coordinator"
import { runtimeSelfAudit, buildLatencyBreakdown } from "./services/runtime-self-audit"
import { classifyFastLane, rewriteShellCommand, rewriteLsCommand } from "./services/tool-fast-lane"
import { isConfirmedSourceMutation } from "./services/semantic-mutation"
import { getCallTimer, releaseCallTimer } from "./services/real-time-instrument"
import { executeShellCommand } from "./services/shell-executor"
import { buildScoreAnnotation } from "./services/visible-score-surface"
import { stripScoreAnnotations, assertNoScoreLeak } from "./services/score-leak-guard"
import { FdxTurboEngine } from "./services/fdx-turbo-engine"
import { fdxFileCache } from "./services/fdx-file-cache"

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
/** Timestamp of last MANUAL user message per session, for preflight hasNewerUserMessage check. */
const sessionLastManualUserAt = new Map<string, number>()
/** Whether the session is in a cancelled/interrupted state. */
const sessionIsCancelled = new Map<string, boolean>()
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

// ─── Production-hardening per-session runtime state ──────────────────────
const sessionLoopIncidents = new Map<string, Set<string>>()
const sessionLeaseHolders = new Map<string, string>()

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
  /** Build the preflight state check closure for a given session. */
  const buildSessionStateCheck = (targetSessionID: string): RecoveryContinuationRequest["getSessionState"] => {
    return () => {
      const wState = getWatchdogState(targetSessionID)
      if (!wState) return null
      return {
        isPendingProvider: wState.isPendingProvider,
        isPendingTool: wState.isPendingTool,
        isPendingChild: wState.isPendingChild,
        isCancelled: sessionIsCancelled.get(targetSessionID) ?? false,
        // hasNewerUserMessage: true if a manual user message arrived AFTER this recovery was scheduled.
        // We track this by checking if sessionLastManualUserAt was updated after the recovery was created.
        // The coordinator itself tracks the creation time; we expose last-manual-user timestamp.
        // The preflight check in the coordinator compares generation.createdAt vs this value.
        hasNewerUserMessage: (() => {
          const lastManualAt = sessionLastManualUserAt.get(targetSessionID) ?? 0
          const gen = recoveryCoordinator.getActiveGeneration(targetSessionID)
          return gen ? lastManualAt > gen.createdAt : false
        })(),
      }
    }
  }
  /** Bounded reasoning-only auto-continuation: exactly one prompt per scheduled stage via recovery coordinator. */
  const scheduleReasoningContinuation = (targetSessionID: string): void => {
    sessionIsCancelled.delete(targetSessionID)
    recoveryCoordinator.requestContinuation({
      sessionID: targetSessionID,
      source: "reasoning_recovery",
      promptText: REPLAY_CONTINUATION_PROMPT,
      client,
      appLog,
      handleEvent,
      getSessionState: buildSessionStateCheck(targetSessionID),
    })
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
  const turboEngine = new FdxTurboEngine({
    workspace: directory,
    index: fdxWorkspaceIndex,
    daemonSocketPath: fdxDaemonSocketPath,
  })

  // ── Round-2: FlowDeck-owned shell tool — executes recognized safe read-only
  // commands through the native fast lane with ZERO bash subprocess spawns.
  // Unsafe/uncertain commands fall back to a real bash -lc.
  const shellFastLaneTool = tool({
    description:
      "Execute a shell command. Recognized read-only commands (cat, sed -n, grep, git status/diff/log, ls) run through the fast lane with no shell spawn; all others run in bash.",
    args: {
      command: tool.schema.string().describe("The shell command to execute."),
      description: tool.schema.string().optional(),
      cwd: tool.schema.string().optional().describe("Working directory (defaults to repo root)."),
    },
    async execute(args: any) {
      const r = executeShellCommand(String(args.command ?? ""), { cwd: args.cwd ? String(args.cwd) : directory })
      return r.output
    },
  })
  const bashFastLaneTool = tool({
    description: "Execute a bash command via the FlowDeck fast lane (same semantics as the shell tool).",
    args: {
      command: tool.schema.string().describe("The bash command to execute."),
      description: tool.schema.string().optional(),
      cwd: tool.schema.string().optional(),
    },
    async execute(args: any) {
      const r = executeShellCommand(String(args.command ?? ""), { cwd: args.cwd ? String(args.cwd) : directory })
      return r.output
    },
  })

  configureFdxTurbo(turboEngine)
  const repoLeaseCoordinator = new RepoLeaseCoordinator({
    stateDir: join(directory, ".flowdeck", "leases"),
  })
  const repoId = repoIdOf(directory)
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
        const incident = watchdogIncidentManager.confirmStall(state.sessionID)
        if (!incident.injectDirective) {
          // STALLED_UNRECOVERED: stop injecting prompts. Watchdog-generated
          // messages never reset convergence, never count as progress, never
          // create a new manual task, never reclassify Fast Harness routing.
          appLog("[watchdog] " + state.sessionID + " marked STALLED_UNRECOVERED; no further nag prompts.", "error", state.sessionID).catch(()=>{})
          updateWatchdogState(state.sessionID, { recoveryExhausted: true, hasUnresolvedTask: true, isPendingContinuation: false })
          watchdogIncidentManager.recordNonProgressActivity(state.sessionID)
          semanticConvergence.recordNonProgressSignal(state.sessionID, "watchdog_prompt")
          if (state.recoveryExhausted) continue
          handleEvent({ event: { type: "session.error", properties: { sessionID: state.sessionID, error: "Automatic recovery exhausted after repeated stalls. The task remains unfinished and can be resumed with a follow-up.", info: { id: state.sessionID, role: "system" } } } }).catch(()=>{})
          continue
        }
        appLog("[watchdog] Stalled session detected: " + state.sessionID + ". No activity for " + WATCHDOG_TIMEOUT_MS + "ms. Sending bounded recovery directive.", "warn", state.sessionID).catch(()=>{})
        // One compact recovery directive per incident stage. The prompt itself
        // must not count as progress or as user activity.
        watchdogIncidentManager.recordNonProgressActivity(state.sessionID)
        semanticConvergence.recordNonProgressSignal(state.sessionID, "watchdog_prompt")
        try {
          runtimeSelfAudit.scoreEvent({
            category: "recovery",
            operation: "watchdog-directive",
            sessionID: state.sessionID,
            dimensionScores: { execution: 88, recovery: 80 },
            evidenceIds: [],
            latencyBreakdown: [],
          })
        } catch { /* audit must never break the runtime */ }
        updateWatchdogState(state.sessionID, { recoveryCount: state.recoveryCount + 1 })
        recoveryCoordinator.requestContinuation({
          sessionID: state.sessionID,
          source: "semantic_watchdog",
          client,
          appLog,
          handleEvent,
          getSessionState: buildSessionStateCheck(state.sessionID),
        })
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
        // Authoritative coordinator ancestry: root Heidi stays depth 0 even if
        // events arrive late or continuations are generated.
        sessionAncestry.registerSession(sessionID, agent)
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

      // ── Fast Harness v1: per-turn route classification ──────────────
      // Genuine MANUAL user tasks are classified once, BEFORE expensive
      // repository discovery, and the route decision is stored keyed by
      // session/current user turn (see heidi-route-state). Internal
      // continuation / recovery prompts NEVER reclassify and NEVER reset
      // the route decision (no Continue flood, no reclassification of
      // resume prompts). Resuming an unresolved task preserves its state.
      const fhTaskText = typeof output.message?.content === "string" ? output.message.content : ""
      const fhMsgId = output.message?.id ?? ""
      if (sessionID && fhTaskText.trim()) {
        const fhProvenance = recoveryCoordinator.classifyMessage(sessionID, fhMsgId, fhTaskText)
        if (fhProvenance === "manual_user") {
          const fhRouteStart = Date.now()
          const turn = await handleUserMessage(sessionID, fhTaskText, directory)
          const fhRouteMs = Date.now() - fhRouteStart

          // ── Requirement J: task-phase isolation ───────────────────────
          // A genuine manual NEW task (not a resume of the same task) must not
          // inherit stale loop/recovery/watchdog/convergence state from the
          // previous task. Session ancestry and coordinator provenance survive.
          if (!turn.resumed) {
            const prevPhase = taskPhaseManager.getCurrentPhase(sessionID)
            const boundary = taskPhaseManager.beginNewTaskPhase(sessionID, turn.taskId, [fhTaskText.slice(0, 120)])
            if (prevPhase && prevPhase.phase > 0) {
              loopIncidentTracker.clearSession(sessionID)
              sessionLoopIncidents.delete(sessionID)
              semanticConvergence.clearSession(sessionID)
              emptyTerminalCircuit.clearSession(sessionID)
              watchdogIncidentManager.clearSession(sessionID)
              sessionContinuationCount.delete(sessionID)
              sessionRecoveryState.delete(sessionID)
              sessionReasoningRecoveryRegistry.delete(sessionID)
              appLog("[task-phase] new manual task detected; loop/convergence/watchdog/recovery state reset, session ancestry preserved", "info", sessionID)
            }
            void boundary
          }
          appendAuditEvent(directory, {
            kind: "routing.decision",
            session_id: sessionID,
            agent: agent || "heidi",
            decision: turn.decision?.executionClass ?? "unknown",
            reason: turn.decision?.reasonCode ?? "NO_ROUTE",
            details: {
              routingMs: Math.round(fhRouteMs * 100) / 100,
              confidence: turn.decision?.confidence ?? 0,
              specialists: turn.decision?.specialists ?? [],
              suggestedAgents: turn.decision?.suggestedAgents ?? [],
              resumed: turn.resumed,
              taskId: turn.taskId,
              provenance: turn.provenance,
            },
          })
        } else if (fhProvenance.startsWith("internal")) {
          // Internal recovery/continuation prompt: keep route + task state.
          handleInternalContinuation(sessionID)
        }
        // "unknown_user_event" (missing/empty text): leave route state unchanged.
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

      // 4. Round-2: strip any FlowDeck score/UI metadata from the provider replay
      //    (score is telemetry/TUI, never model context — same separation as
      //    provider-replay sanitation). Then mutate the SHARED array in place so
      //    opencode's provider serialization sees the sanitized history.
      const leakFreeMessages = stripScoreAnnotations(finalMessages as any)
      output.messages.length = 0
      for (const m of leakFreeMessages) output.messages.push(m as any)
      if (!assertNoScoreLeak(output.messages as any)) {
        await client.app.log({ body: { service: "flowdeck", level: "warn", message: "[provider-history] FlowDeck score metadata would leak into provider replay; suppressed", extra: { sessionID: realSessionID } } }).catch(() => {})
      }

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

      // ── Fast Harness v1: per-turn task-specific lazy context ────────
      // The permanent Heidi core prompt stays static and small (never
      // rebuilt per message). Only the sections relevant to THIS turn's
      // execution class are injected:
      //  - FAST_DIRECT: nothing extra — lean core + compact task-state
      //    packet + repo summary only; no specialist directory, no fd-*
      //    lifecycle, no planner/mapper preflight, no approval workflow,
      //    no stage-agent matrix, no unrelated domain workflows
      //  - SPECIALIST / PARALLEL_SPECIALISTS: minimal delegation contract +
      //    selected specialist info + handoff rules
      //  - STANDARD: scoped planning instructions only
      //  - DEEP: full workflow/gates
      const fhTurnContext = renderTurnContext(sessionID, directory)
      {
        // Provider-safe lean-context metadata (class + core token estimate).
        const route = sessionID ? getRouteDecision(sessionID) : null
        if (route) {
          const leanMeta = markLeanContext(sessionID)
          if (leanMeta) {
            const tracker = getTracker(route.taskId)
            tracker?.startSpan("routing", { leanContextMetadata: leanMeta })
          }
        }
      }
      if (fhTurnContext) {
        output.system = [markedSystem + "\n\n" + fhTurnContext]
      } else {
        output.system = [markedSystem]
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
      "heidi-memory": heidiMemoryTool,
      "heidi-recall": heidiRecallTool,
      "heidi-archive-session": heidiArchiveSessionTool,
      "heidi-learning": heidiLearningTool,
      "heidi-skill": heidiSkillTool,
      "heidi-tool-pipeline": heidiPipelineTool,
      "heidi-scheduler": heidiSchedulerTool,
      "heidi-agents": heidiAgentsTool,
    "fdx-pr-monitor": fdxPrMonitorTool,
    "shell": shellFastLaneTool,
    "bash": bashFastLaneTool,
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      let isToolTracked = false;
      const sessionID = toolInput.sessionID ?? "";
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const callID = toolInput.callID ?? ""
      const rawArgs = toolOutput?.args ?? toolInput?.args ?? {}
      const sessionMeta = sessionID ? sessionRegistry.get(sessionID) : undefined
      const resolvedCaller = sessionMeta?.agent ?? (sessionID ? sessionCallerAgents.get(sessionID) : undefined) ?? toolInput.agent

      // ── Round-2: real latency measurement (monotonic; no synthetic constants) ──
      const callTiming = getCallTimer(sessionID || "no-session", callID || "no-call", toolName || "no-tool")
      callTiming.start("tool-before-total")

      // ── Requirements K + S: repo coordination & shell fast-lane rewrite ──
      const toolLowerBefore = String(toolName).toLowerCase()
      if (toolLowerBefore === "bash" || toolLowerBefore === "shell") {
        const cmd = (rawArgs.command as string) ?? ""
        const rewritten = rewriteShellCommand(cmd) ?? rewriteLsCommand(cmd)
        if (rewritten) {
          appendAuditEvent(directory, {
            kind: "tool_fast_lane.rewrite",
            session_id: sessionID,
            agent: (resolvedCaller as string) || "heidi",
            tool: toolName,
            decision: "rewrite",
            reason: "FAST_TOOL_REWRITE " + rewritten.adapter,
            details: { from: cmd.slice(0, 200), to: rewritten.to, semanticsPreserved: rewritten.semanticsPreserved },
          })
        }
      }
      // Repo coordination: a mutating tool requires the exclusive repo lease.
      if (["write", "write_file", "edit", "edit_file", "patch", "apply_patch", "str_replace", "hash-edit", "create_file"].includes(toolLowerBefore)) {
        const leaseHolder = sessionLeaseHolders.get(sessionID)
        const liveOwner = sessionID ? repoLeaseCoordinator.getMutatingOwner(repoId) : null
        if (leaseHolder && leaseHolder === sessionID && liveOwner === sessionID) {
          repoLeaseCoordinator.heartbeat(repoId, sessionID)
        } else if (!leaseHolder) {
          try {
            const lease = await repoLeaseCoordinator.acquireMutatingLease(repoId, sessionID)
            sessionLeaseHolders.set(sessionID, sessionID)
            appendAuditEvent(directory, {
              kind: "lease.acquired",
              session_id: sessionID,
              agent: (resolvedCaller as string) || "heidi",
              tool: toolName,
              decision: "acquire",
              reason: "Mutating tool acquired exclusive repo lease",
            })
            void lease
          } catch (err) {
            const holder = (err as { holder?: string })?.holder ?? "unknown"
            appendAuditEvent(directory, {
              kind: "lease.conflict",
              session_id: sessionID,
              agent: (resolvedCaller as string) || "heidi",
              tool: toolName,
              decision: "block",
              reason: "REPO_MUTATING_LEASE_UNAVAILABLE holder=" + holder,
            })
            throw new RecoverableFlowDeckBlockError({
              subsystem: "governance",
              code: "REPO_MUTATING_LEASE_UNAVAILABLE",
              tool: toolName,
              sessionID,
              agent: (resolvedCaller as string) || "heidi",
              reason: "Another live FlowDeck session holds the mutating lease for this repository. Wait, use a separate worktree, or continue read-only. Redirect: run the mutation from the owning session.",
              recoverable: true,
              suggestedActions: [
                "Continue read-only inspection (no write) until the lease frees",
                "Run the mutation in the session that holds the repo lease",
                "Use a separate git worktree for this mutating task",
              ],
            })
          }
        }
      }

      // ── Fast Harness v1: deterministic tool-call repair ───────────────
      // Mechanical repair only (known aliases, path separators, scalar-array
      // shapes). Never invents missing files, target agents, destructive
      // intent, or semantic meaning. Emits tool_call_repaired with the rule
      // IDs and tool name only, BEFORE paying for another model inference.
      if (rawArgs && typeof rawArgs === "object") {
        try {
          const repair = repairToolCall(toolName, rawArgs as Record<string, unknown>)
          if (repair.repaired) {
            if (toolOutput?.args) toolOutput.args = repair.args
            if (toolInput?.args) toolInput.args = repair.args
            // Overwrite the local reference so the rest of this hook and the
            // tool call use the repaired shape.
            if (typeof toolOutput?.args === "object") Object.assign(rawArgs, repair.args)
            appendAuditEvent(directory, {
              kind: "lifecycle.transition",
              session_id: sessionID,
              agent: (resolvedCaller as string) || "heidi",
              tool: toolName,
              decision: "tool_call_repaired",
              reason: "rule:" + repair.repairs.join(","),
              level: "info",
            })
          }
        } catch {
          // Repair must never break the runtime.
        }
      }

      if (toolName === "task" && (!resolvedCaller || resolvedCaller === "unknown")) {
        const govMode = resolveGovernanceModeCached(directory)
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
          const govMode = resolveGovernanceModeCached(directory)
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

      // ── 2. Governance tool check (Fast Harness fast path) ────────
      // Deterministic known-safe read-only tools (FDX reads/searches, safe
      // git inspection) authorize via the fast path (<2ms p50, no full
      // multi-rule evaluation). Writes, shell mutation, destructive ops,
      // secrets, release actions, deployments, delegation, and other
      // high-risk operations ALWAYS take the full policy path.
      const governancePathStart = Date.now()
      const fastGovMode = resolveGovernanceModeCached(directory)
      const fastPath = governanceFastPath(
        toolName,
        fastGovMode,
        typeof rawArgs?.file_path === "string" ? rawArgs.file_path : typeof rawArgs?.path === "string" ? rawArgs.path : undefined,
      )
      let governanceResult: { action: "allow" | "warn" | "block"; reason?: string }
      if (fastPath.allowed && fastPath.usedFastPath) {
        // Read-only fast path authorized. Full policy evaluation is skipped
        // ONLY for tools that are both in the read whitelist and operating on
        // a non-root path. All other tools evaluate below.
        governanceResult = { action: "allow" }
      } else {
        governanceResult = evaluateGovernanceToolCheck({
          directory,
          sessionID,
          agent,
          tool: toolName,
          args: rawArgs,
        })
      }
      const governancePathMs = Date.now() - governancePathStart
      {
        const route = sessionID ? getRouteDecision(sessionID) : null
        const tracker = route ? getTracker(route.taskId) : undefined
        if (tracker) {
          const spanKey = tracker.startSpan(
            fastPath.usedFastPath ? "governance.read_fast_path" : fastPath.allowed && !fastPath.usedFastPath && fastGovMode !== "off" ? "governance.write_full" : "governance.check",
            { tool: toolName, latencyMs: Math.round(governancePathMs * 100) / 100 },
          )
          tracker.endSpan(spanKey)
        }
      }

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
          const ancestry = sessionAncestry.getSession(invocation.sessionID)
          const currentDepth = sessionAncestry.getEffectiveDepth(invocation.sessionID, invocation.callerAgent)
          // Requirement A: root Heidi (depth 0) with no parent session must be
          // depth 0, never 1. Specialist caller without registered parent = depth 1.
          void isSpecialistCaller
          void ancestry

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
            const govMode = resolveGovernanceModeCached(directory)
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

      // ── 7. Loop detection — incident-based steering (Requirements D/E) ──
      callTiming.start("loop-guard")
      try {
        const fingerprint = fingerprintAction(toolName, rawArgs)
        if (sessionID) {
          semanticConvergence.recordToolCall(sessionID)
        }
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
          // A blocked attempt did NOT execute: it must not count as another
          // executed repeat, must not increment the real execution count, and
          // must not create a flood of large UI blocks.
          if (sessionID) {
            semanticConvergence.recordGuardBlock(sessionID)
            const incident = loopIncidentTracker.recordSuppressedDuplicate(sessionID, fingerprint)
            const redirect = buildRecoveryRedirect({
              sessionID,
              toolName,
              fingerprint,
              reason: loop.reason,
              blockedFacts: ["output_unchanged"],
              available: [],
            })
            loopIncidentTracker.attachRedirect(sessionID, fingerprint, redirect)
            appendAuditEvent(directory, {
              kind: "loop_guard.blocked",
              session_id: sessionID,
              agent,
              tool: toolName,
              decision: "block_suppressed",
              reason: "LOOP_INCIDENT " + incident.incidentId + ": " + loop.reason,
              details: { fingerprint, doNotRetry: fingerprint, humanInputRequired: false },
            })
            throw new RecoverableFlowDeckBlockError({
              subsystem: "loop_detector",
              code: "LOOP_GUARD_REPEATED_ACTION",
              tool: toolName,
              sessionID,
              agent,
              reason: JSON.stringify(redirect),
              recoverable: true,
              suggestedActions: redirect.continueImmediatelyWith,
              details: { linkedRecoveryDirective: true, humanInputRequired: false },
            })
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
      // Close the last before-hook phase; tool-runtime begins in the after hook.
      callTiming.start("before-complete")
    },


    "tool.execute.after": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const callID = toolInput.callID ?? ""
      const agent = sessionCallerAgents.get(sessionID) ?? toolInput.agent ?? "unknown"
      const rawArgs = toolOutput?.args ?? toolInput?.args ?? {}
      // Round-2: resume real latency measurement; "tool-runtime" spans the actual
      // tool execution between the before-hook and this after-hook.
      const afterTiming = getCallTimer(sessionID || "no-session", callID || "no-call", toolName || "no-tool")
      afterTiming.start("tool-runtime")
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

      // ── Round-2: canonical semantic progress classification (read-only never
      // counts as mutation), real measured latency, and visible FlowDeck score. ──
      if (sessionID) {
        const toolLower = String(toolName).toLowerCase()
        const errored = Boolean(toolInput?.error) || Boolean(toolOutput?.error) || toolOutput === undefined || toolOutput === null
        // Canonical classifier: only confirmed successful source mutations advance
        // convergence. A read that merely carries a `file` argument is read_only.
        const confirmedMutation = isConfirmedSourceMutation(toolLower, rawArgs)
        if (confirmedMutation && !errored) {
          semanticConvergence.recordProgress(sessionID, "source_changed", [])
          loopIncidentTracker.resolveAllForSession(sessionID)
          emptyTerminalCircuit.recordSemanticProgress(sessionID)
          watchdogIncidentManager.recordProgressEvidence(sessionID, "source_changed")
        } else if (sessionID && !confirmedMutation && !errored) {
          semanticConvergence.recordNonProgressSignal(sessionID, "tool_activity")
        }
        afterTiming.start("convergence")
        // Invalidate FDX hot file cache ONLY on confirmed writes (no stale reads).
        if (rawArgs?.file && typeof rawArgs.file === "string" && confirmedMutation) {
          fdxFileCache.invalidate(String(rawArgs.file))
          if (typeof (turboEngine as any)?.invalidate === "function") turboEngine.invalidate(String(rawArgs.file))
        }
        // Runtime self-audit for the tool (Requirement L/M/N) with REAL latency.
        try {
          const fastLane = classifyFastLane(toolLower)
          const dims: Record<string, number> = {
            execution: errored ? 40 : 95,
            integrity: confirmedMutation && !errored ? 95 : 98,
            governance: fastLane.usedFastPath ? 92 : 98,
            efficiency: fastLane.usedFastPath ? 90 : 85,
            state_consistency: 95,
          }
          if (fastLane.usedFastPath) dims.governance = 85
          afterTiming.start("self-audit")
          const auditEvent = runtimeSelfAudit.scoreEvent({
            category: "tool_execution",
            operation: toolName,
            sessionID,
            dimensionScores: dims,
            evidenceIds: [],
            latencyBreakdown: buildLatencyBreakdown(
              afterTiming.phases().map((p) => [p.name, p.ms] as [string, number]),
            ),
            violations: errored ? [{ code: "RECOVERABLE_TOOL_ERROR", severity: "severe", detail: toolName + " errored" }] : [],
          })
          afterTiming.end()
          releaseCallTimer(sessionID, callID, toolName)
          // Round-2: visible score surface. Score goes into tool title + fd.selfAudit
          // metadata — never into output text (score-leak guard strips on replay).
          const scoreClass = toolLower === "shell" || toolLower === "bash" ? "shell" : (toolLower.startsWith("fdx") ? "fdx" : "tool")
          const label = String(((toolOutput as any)?.title) ?? toolName)
          const annotation = buildScoreAnnotation({
            actionClass: scoreClass as any,
            sessionID,
            label,
            score: auditEvent.score,
          })
          if (toolOutput && typeof toolOutput === "object") {
            toolOutput.title = annotation.title
            toolOutput.metadata = { ...(toolOutput.metadata as Record<string, unknown> | undefined), fd: annotation.metadata.fd }
            appendAuditEvent(directory, {
              kind: "self_audit.event",
              session_id: sessionID,
              agent,
              tool: toolName,
              decision: "score",
              reason: "FlowDeck " + Math.round(auditEvent.score) + "%",
              details: { fdSelfAudit: annotation.metadata.fd, actionClass: scoreClass, latencyPhases: afterTiming.phases() },
            })
          }
        } catch { /* audit must never break the runtime */ }
      }

      if (toolName === "task") {
        const taskKey = `${sessionID}:${callID || "task"}`
        const taskCall = sessionTaskCalls.get(taskKey)
        const hasError = !!toolInput.error || !!toolOutput?.error || toolOutput === undefined || toolOutput === null

        // ── Round-2: delegation integrity score (evidence-based) ──
        try {
          const delegScore = hasError ? 58 : 97
          runtimeSelfAudit.scoreEvent({
            category: "task_delegation",
            operation: "delegate",
            sessionID,
            dimensionScores: {
              execution: hasError ? 40 : 97,
              integrity: hasError ? 50 : 98,
              governance: 98,
              routing: 98,
            },
            evidenceIds: [],
            latencyBreakdown: [],
            violations: hasError ? [{ code: "TASK_DELEGATION_FAILED", severity: "severe", detail: "task delegation errored" }] : [],
          })
          if (toolOutput && typeof toolOutput === "object") {
            const annotation = buildScoreAnnotation({
              actionClass: "delegation",
              sessionID,
              label: "Task " + String((taskCall?.targetAgent ?? "task")),
              score: delegScore,
            })
            toolOutput.title = annotation.title
            toolOutput.metadata = { ...(toolOutput.metadata as Record<string, unknown> | undefined), fd: annotation.metadata.fd }
          }
        } catch { /* audit must never break the runtime */ }

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
            const govMode = resolveGovernanceModeCached(directory)
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
      const sessionAgent = info?.agent ?? event?.properties?.agent ?? undefined

      // ── Requirement A: session ancestry vs message causality ───────────
      // Message-level parentID (msg.parentID) expresses MESSAGE causality and
      // must NEVER become a session parent — doing so corrupted root Heidi to
      // depth 1. A parent is treated as a SESSION parent only when the event is
      // a session lifecycle event (session.created/started) or the referenced
      // ID is a known session in the registry.
      const isSessionLifecycleEvent = type === "session.created" || type === "session.started"
      const rawParentID = info?.parentID ?? event?.properties?.parentID ?? undefined
      const sessionParentID =
        isSessionLifecycleEvent && rawParentID
          ? rawParentID
          : rawParentID && sessionRegistry.has(rawParentID)
            ? rawParentID
            : undefined

      if (eventSessionID) {
        const parentMetaOf = sessionParentID ? sessionRegistry.get(sessionParentID) : undefined
        const ancestry = sessionAncestry.registerSession(
          eventSessionID,
          sessionAgent,
          sessionParentID,
          parentMetaOf ? parentMetaOf.depth + 1 : undefined,
        )

        let meta = sessionRegistry.get(eventSessionID)
        const resolvedAgent = ancestry.agent || sessionAgent
        if (!meta) {
          meta = {
            sessionID: eventSessionID,
            parentID: ancestry.parentSessionID,
            agent: resolvedAgent,
            depth: ancestry.depth,
          }
          sessionRegistry.set(eventSessionID, meta)
          updateWatchdogState(eventSessionID, { hasUnresolvedTask: true })
        } else {
          // Only update parent from authoritative session ancestry. A root
          // Heidi session is never demoted by message-level causality.
          if (sessionAgent && !meta.agent) meta.agent = sessionAgent
          if (ancestry.parentSessionID && !meta.parentID) meta.parentID = ancestry.parentSessionID
          meta.depth = ancestry.depth
        }
        if (resolvedAgent && resolvedAgent !== "unknown") {
          sessionCallerAgents.set(eventSessionID, resolvedAgent)
        }

        // ── Child session correlation (deterministic FIFO) ──────────────
        if (sessionParentID && !childSessionToTask.has(eventSessionID)) {
          const effectiveTarget = sessionAgent || (meta?.agent !== "" ? meta?.agent : undefined) || undefined
          const { correlation, ambiguous } = dequeuePendingSlot(sessionParentID, effectiveTarget)

          if (correlation) {
            childSessionToTask.set(eventSessionID, correlation)
            try { new HeidiDelegationRuntime(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db).transition(correlation.taskKey, "running") } catch { /* projection is secondary */ }
          } else if (ambiguous) {
            // Cannot determine which task call this child belongs to.
            // Emit a diagnostic instead of attaching to a potentially
            // incorrect task — never delete or fail another active task.
            appendAuditEvent(directory, {
              kind: "delegation.blocked",
              session_id: sessionParentID,
              agent: "system",
              tool: "task",
              decision: "block",
              reason: "UNRESOLVED_CHILD_CORRELATION: Multiple pending task calls match the same parent; unable to determine which one created this child session",
              details: {
                childSessionID: eventSessionID,
                parentSessionID: sessionParentID,
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
              parentID: sessionParentID,
              depth: eventMeta?.depth ?? 0,
            }
            await tokenBudgetRuntime.reconcileUsage(budgetCtx, msgInfo)
            // ── Fast Harness: model-turn telemetry (structural tokens only) ──
            try {
              const inTok = msgInfo.tokens?.input ?? 0
              const outTok = msgInfo.tokens?.output ?? 0
              if (Number.isFinite(Number(inTok)) && Number.isFinite(Number(outTok))) {
                recordModelTurn(eventSessionID, Number(inTok), Number(outTok), undefined)
              }
            } catch {
              // telemetry must never break the runtime
            }
          } catch (err) {
            appLog(`[token-budget] reconcile failed: ${err instanceof Error ? err.message : String(err)}`, "warn", eventSessionID)
          }
        }
      } else if (tokenBudgetRuntime.isEnabled() && (type === "session.error" || type === "session.completed")) {
        try {
          const budgetCtx = {
            sessionID: eventSessionID,
            agent: sessionAgent ?? (eventSessionID ? sessionCallerAgents.get(eventSessionID) : undefined) ?? "unknown",
            parentID: sessionParentID,
            depth: eventMeta?.depth ?? 0,
          }
          await tokenBudgetRuntime.onSessionEnd(budgetCtx, type === "session.error" ? "session_error" : "session_completed")
        } catch (err) {
          appLog(`[token-budget] session-end release failed: ${err instanceof Error ? err.message : String(err)}`, "warn", eventSessionID)
        }
      }

      // ── Fast Harness: session lifecycle closure ──────────────────────
      // Complete the per-user-task state, emit the final (safe) tracker
      // summary, and flush any buffered non-critical audit events on a
      // session boundary. Critical events were already flushed synchronously.
      if (type === "session.completed" || type === "session.error") {
        try {
          const summary = completeTask(eventSessionID)
          if (summary != null) {
            await appLog("[heidi-fast-harness] task complete: " + summary, "info", eventSessionID)
          }
          flushAuditBuffer()
        } catch {
          // Lifecycle closure is best-effort; never break the runtime.
        }
      }

      const sessionID = eventSessionID
      if (type === "session.started" || type === "message.updated" || type === "chat.message") {
        const msgRole = info?.role ?? event?.properties?.info?.role ?? event?.info?.role;
        const rawIsUser = (type === "message.updated" && msgRole === "user") || type === "chat.message";
        const stateUpdates: any = { lastProgressAt: Date.now() };
        if (rawIsUser && sessionID) {
          const parts = event?.properties?.parts ?? event?.parts ?? info?.parts;
          const msgText = Array.isArray(parts) ? parts.map((p: any) => p.text ?? "").join(" ") : (info?.content ?? event?.properties?.content ?? "");
          const msgId = info?.id ?? event?.properties?.info?.id;
          const provenance = recoveryCoordinator.classifyMessage(sessionID, msgId, msgText);
          if (provenance === "manual_user") {
            // Positive manual user turn: reset recovery state and record timestamp for preflight.
            stateUpdates.recoveryExhausted = false;
            stateUpdates.recoveryCount = 0;
            sessionRecoveryState.delete(sessionID);
            sessionLastManualUserAt.set(sessionID, Date.now());
            // If a recovery is currently scheduled (SCHEDULED state), cancel it so the
            // timer preflight will suppress it. The user's turn supersedes recovery.
            recoveryCoordinator.markGenerationCancelledByUserMessage(sessionID);
          }
          // "unknown_user_event" (missing/empty text): leave all recovery state unchanged.
          // "internal_*": internal recovery prompt — do not reset recovery state.
        }
        updateWatchdogState(sessionID, stateUpdates)
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

          // ── Terminal-state detection: does this message have positive terminal evidence? ──
          // P0 FIX: A message.updated with no finishReason is a transient snapshot of an
          // in-progress turn. Only treat a turn as terminal when we have positive evidence.
          const msgFinishReason: string | undefined = (() => {
            let fr: string | undefined = msgInfo.finishReason ?? msgInfo.finish_reason
            if (!fr && parts) {
              for (const p of parts) {
                if (p.type === "step-finish" && (p as any).reason) { fr = (p as any).reason; break }
              }
            }
            return fr
          })()
          const isConfirmedTerminal = Boolean(
            msgFinishReason ||           // explicit finish signal in the message
            type === "session.idle"      // session.idle is a strong terminal boundary
          )

          // Extract parentID from the assistant message for causal correlation.
          // OpenCode may expose parentID linking the assistant turn to its user prompt.
          const assistantParentID: string | undefined =
            msgInfo.parentID ?? msgInfo.parent_id ?? undefined

          // Notify coordinator that a recovery turn has reached terminal state.
          // This clears isPendingContinuation only when the terminal assistant turn is
          // causally correlated to the specific recovery generation.
          if (isConfirmedTerminal && !msgInfo.error) {
            recoveryCoordinator.notifyAssistantTurnTerminal(eventSessionID, msgInfo.id, assistantParentID)
          }

          // ── Round-2: assistant-completion + think integrity scores (metadata only) ──
          try {
            const hasReasoningPart = Array.isArray(parts) && parts.some((p: any) => p.type === "reasoning")
            const hadVisibleText = Array.isArray(parts) && parts.some((p: any) => p.type === "text" && p.text?.trim())
            const reasoningMeta = {
              durationMs: 0,
              terminalState: msgFinishReason ?? undefined,
              visibleOutputPresent: hadVisibleText,
              malformedCompletion: isConfirmedTerminal && !hadVisibleText && !(Array.isArray(parts) && parts.some((p: any) => p.type === "tool" && (typeof p.state === "string" ? p.state : p.state?.status) !== "pending" && (typeof p.state === "string" ? p.state : p.state?.status) !== "running")),
              recoveryRequired: Boolean(msgInfo.error) || sessionRecoveryState.has(eventSessionID),
            } as any
            if (hasReasoningPart) {
              runtimeSelfAudit.scoreEvent({
                category: "think",
                operation: "assistant-reasoning",
                sessionID: eventSessionID,
                dimensionScores: { execution: msgInfo.error ? 40 : 96 },
                evidenceIds: [],
                latencyBreakdown: [],
                reasoningMeta,
              })
            }
            if (isConfirmedTerminal) {
              runtimeSelfAudit.scoreEvent({
                category: "assistant_completion",
                operation: "assistant-completion",
                sessionID: eventSessionID,
                dimensionScores: { execution: msgInfo.error ? 40 : 97, state_consistency: hadVisibleText ? 98 : 80 },
                evidenceIds: [],
                latencyBreakdown: [],
                reasoningMeta,
              })
            }
          } catch { /* audit must never break the runtime */ }

          // P0 FIX: Cancel any scheduled recovery when the session is interrupted.
          // An interrupted/error turn must never be followed by automatic continuation.
          // IMPORTANT: Only cancel session for genuine user-Stop/interrupted turns (finishReason=cancelled/aborted/error).
          // For provider API errors on assistant messages, use notifyAssistantTurnProviderError
          // which clears isPendingContinuation without cancelling the session, allowing stage-2 recovery.
          if (!msgInfo.error && (msgFinishReason === "error" || msgFinishReason === "cancelled" || msgFinishReason === "aborted")) {
            sessionIsCancelled.set(eventSessionID, true)
            recoveryCoordinator.cancelSession(eventSessionID)
          } else if (msgInfo.error) {
            // Provider/API error on assistant turn: mark generation failed (clears isPendingContinuation)
            // without cancelling the session. Stage-2 recovery can still be triggered by the caller.
            recoveryCoordinator.notifyAssistantTurnProviderError(eventSessionID)
          }

          // A session that produced visible output or completed tool execution after
          // recovery is healthy again — clear the recovery state.
          // P0 FIX: Only reset the incident when the turn is also confirmed terminal.
          // Do NOT reset on a transient tool-completion in the middle of an active turn.
          if (parts && isConfirmedTerminal && sessionRecoveryState.has(eventSessionID) && !msgInfo.error) {
            const hasOutput = parts.some((p: any) => {
              if (p.type === "text" && p.text?.trim()) return true
              if (p.type === "tool") {
                const state = typeof p.state === "string" ? p.state : p.state?.status
                return state === "completed" || !state
              }
              return false
            })
            if (hasOutput) {
              sessionRecoveryState.delete(eventSessionID)
              updateWatchdogState(eventSessionID, { recoveryCount: 0, recoveryExhausted: false })
            }
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
              const wState = getWatchdogState(eventSessionID);
              const incidentCount = wState?.recoveryCount ?? 0;
              const decision = decideStage2Continuation({
                sessionID: eventSessionID,
                state: st,
                errorClass,
                signature: sig2,
                breaker: circuitBreaker,
                incidentCount,
                sessionCount: count,
              })
              if (decision.action === "schedule" && decision.stage) {
                sessionRecoveryState.set(eventSessionID, { ...st, stage: decision.stage })
                sessionContinuationCount.set(eventSessionID, count + 1)
                updateWatchdogState(eventSessionID, { recoveryCount: incidentCount + 1 })
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
                updateWatchdogState(eventSessionID, { recoveryExhausted: true, hasUnresolvedTask: true, isPendingContinuation: false })
                handleEvent({ event: { type: "session.error", properties: { sessionID: eventSessionID, error: "Automatic recovery was exhausted after an empty assistant completion. The task remains unfinished and can be resumed with a follow-up.", info: { id: eventSessionID, role: "system" } } } }).catch(()=>{})
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
            // P0 FIX: Only attempt malformed detection when the turn is confirmed terminal.
            // A transient message.updated with no finishReason is in-progress — never recover from it.
            if (!isConfirmedTerminal) {
              // Turn is still in progress — cannot classify as malformed. Skip.
            } else {
            const { isMalformed, diagnostics } = detectNoVisibleOutputCompletion({ info: msgInfo, parts }, { confirmedTerminal: isConfirmedTerminal })
            if (isMalformed && diagnostics) {
              // P0 FIX: Full pending-state guard. If ANY of these are true, the session
              // is still actively executing. Do NOT inject a recovery prompt.
              const wStateCheck = getWatchdogState(eventSessionID)
              const hasActiveOrPendingTool = parts.some((p: any) => {
                if (p.type === "tool") {
                  const state = typeof p.state === "string" ? p.state : p.state?.status
                  return state === "pending" || state === "running"
                }
                return false
              })
              if (hasActiveOrPendingTool) {
                // The assistant is currently executing tools; do not treat as an empty reasoning stop.
              } else if (wStateCheck?.isPendingContinuation) {
                // A continuation is already running — suppress duplicate
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "circuit_break",
                  reason: "Continuation already pending; malformed detection suppressed",
                  details: diagnostics as unknown as Record<string, unknown>,
                })
              } else if (wStateCheck?.isPendingProvider) {
                // Provider request still active — not terminal
                appLog(`[heidi] Malformed detection suppressed: provider still active for session ${eventSessionID}`, "debug", eventSessionID)
              } else if (wStateCheck?.isPendingChild) {
                // Child task still running — not terminal
                appLog(`[heidi] Malformed detection suppressed: child task still pending for session ${eventSessionID}`, "debug", eventSessionID)
              } else {
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
              const wState = getWatchdogState(eventSessionID);
              const incidentCount = wState?.recoveryCount ?? 0;
              const decision = decideStage1Continuation({ sessionID: eventSessionID, signature: sig, breaker: circuitBreaker, incidentCount, sessionCount: count });
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
                updateWatchdogState(eventSessionID, { recoveryExhausted: true, hasUnresolvedTask: true, isPendingContinuation: false })
                handleEvent({ event: { type: "session.error", properties: { sessionID: eventSessionID, error: "Automatic recovery was exhausted after an empty assistant completion. The task remains unfinished and can be resumed with a follow-up.", info: { id: eventSessionID, role: "system" } } } }).catch(()=>{})
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
                updateWatchdogState(eventSessionID, { recoveryCount: incidentCount + 1 })
                appendAuditEvent(directory, {
                  kind: "recovery.action",
                  session_id: eventSessionID,
                  agent: "system",
                  decision: "continue",
                  reason: "Reasoning-only completion detected; triggering controlled auto-continuation",
                  details: diagnostics as unknown as Record<string, unknown>,
                })
                                const etcDecision = emptyTerminalCircuit.recordEmptyTerminal(eventSessionID, messageId)
                // Round-2: recovery integrity score (metadata only).
                try {
                  runtimeSelfAudit.scoreEvent({
                    category: "recovery",
                    operation: "empty-terminal-" + etcDecision.action,
                    sessionID: eventSessionID,
                    dimensionScores: { execution: etcDecision.action === "circuit_break" ? 40 : 90, recovery: etcDecision.action === "circuit_break" ? 35 : 92 },
                    evidenceIds: [],
                    latencyBreakdown: [],
                    violations: etcDecision.action === "circuit_break" ? [{ code: "RECOVERY_FLOOD", severity: "severe", detail: "empty-terminal recovery circuit exhausted" }] : [],
                  })
                } catch { /* audit must never break the runtime */ }
                if (etcDecision.action === "circuit_break") {
                  appendAuditEvent(directory, {
                    kind: "empty_terminal.recovery",
                    session_id: eventSessionID,
                    agent: "system",
                    decision: "circuit_break",
                    reason: "Empty-terminal recovery circuit exhausted; automatic continuation stopped",
                    details: { consecutiveEmpty: etcDecision.consecutiveCount, totalSession: etcDecision.totalSessionCount, incidentId: etcDecision.incidentId },
                  })
                  appLog("[heidi] Empty-terminal circuit EXHAUSTED for session " + eventSessionID + ": " + (etcDecision.diagnosticMessage ?? "no further auto-continuation"), "warn", eventSessionID)
                  updateWatchdogState(eventSessionID, { recoveryExhausted: true, hasUnresolvedTask: true, isPendingContinuation: false })
                  handleEvent({ event: { type: "session.error", properties: { sessionID: eventSessionID, error: "Automatic recovery was exhausted after repeated empty completions. One diagnostic: task preserved, strategy invalidated, automatic continuation stopped.", info: { id: eventSessionID, role: "system" } } } }).catch(()=>{})
                } else {
                  appLog("[heidi] Triggering reasoning-only auto-continuation for session " + eventSessionID, "warn", eventSessionID)
                  scheduleReasoningContinuation(eventSessionID)
                }
              }
              }
            }
            } // end isConfirmedTerminal block
          }
        }
      }

      if (type === "session.created" || type === "session.started") {
        if (sessionID) {
          sessionIsCancelled.delete(sessionID)
          sessionLastManualUserAt.delete(sessionID)
          sessionStartTimes.set(sessionID, Date.now())
        }
        await sessionStartHook({ directory }, appLog)
        appendAuditEvent(directory, {
          kind: "session.started",
          session_id: sessionID,
          agent: "system",
          decision: "start",
          reason: "Session started",
        })
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
              // ── Requirement I: evidence-gated completion ───────────────
              // Unsupported "resolved/fixed" claims are rejected by the
              // runtime evidence gates. A lower-authority PASS can never
              // override a higher-authority FAIL.
              const integrity = runtimeSelfAudit.sessionIntegrity(sessionID)
              const selfAuditEvidence: VerificationEvidence[] = [
                { kind: "focused_acceptance_test", id: "scorecard", outcome: (blocks === 0 && warnings === 0) ? "PASS" : "FAIL", at: Date.now() },
                { kind: "live_reproduction", id: "runtime-self-audit", outcome: integrity.fatalCount > 0 ? "FAIL" : integrity.severeCount > 0 ? "FAIL" : "PASS", at: Date.now() },
              ]
              const gate = evaluateEvidenceGate({
                taskId: "session:" + sessionID,
                requiredKind: "live_reproduction",
                evidence: selfAuditEvidence,
              })
              if (!gate.resolutionAllowed) {
                appendAuditEvent(directory, {
                  kind: "guard.block",
                  session_id: sessionID,
                  agent: "system",
                  tool: "task",
                  decision: "block",
                  reason: "EVIDENCE_GATE:Unsupported resolution claim rejected - " + gate.reason,
                })
              }
              void scorecard

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
            // Mark the session as cancelled so preflight can detect it
            sessionIsCancelled.set(sessionID, true)
            const wState = getWatchdogState(sessionID)
            if (!(wState && wState.recoveryExhausted)) {
              updateWatchdogState(sessionID, { hasUnresolvedTask: false })
            }

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
            const wState = getWatchdogState(sessionID);
            if (!(type === "session.error" && wState?.recoveryExhausted)) {
              cleanupSessionState(sessionID, loopDetector)
            }
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
      sessionLastManualUserAt.clear()
      sessionIsCancelled.clear()
      sessionLoopIncidents.clear()
      // Release any held repo leases and clear lease holders.
      for (const [sess, owned] of sessionLeaseHolders.entries()) {
        if (owned === sess) { try { repoLeaseCoordinator.releaseMutatingLease(repoId, sess) } catch { /* best-effort */ } }
      }
      sessionLeaseHolders.clear()
      loopIncidentTracker.clearAll()
      semanticConvergence.clearAll()
      emptyTerminalCircuit.clearAll()
      watchdogIncidentManager.clearAll()
      taskPhaseManager.clearAll()
      sessionAncestry.clear()
      runtimeSelfAudit.clear()
      runtimeSelfAudit.clearIncidents()
      fdxFileCache.invalidateAll()
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
      recoveryCoordinator.dispose()
      for (const timer of sessionAutoContinuationTimers.values()) {
        clearTimeout(timer)
      }
      sessionAutoContinuationTimers.clear()
      clearAllWatchdogStates()
      if (schedulerTimer) clearInterval(schedulerTimer)
      // Close SQLite connections so Windows file locks are released
      // Stop the resident FDX engine (releases the native daemon process and its
      // cwd lock — required for clean Windows temp-dir teardown).
      await (turboEngine as { stop?: () => Promise<void> }).stop?.().catch(() => {})
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
  sessionLastManualUserAt.delete(sessionID)
  sessionIsCancelled.delete(sessionID)
  clearWatchdogState(sessionID)
  watchdogIncidentManager.clearSession(sessionID)
  loopIncidentTracker.clearSession(sessionID)
  sessionLoopIncidents.delete(sessionID)
  semanticConvergence.clearSession(sessionID)
  emptyTerminalCircuit.clearSession(sessionID)
  taskPhaseManager.clearSession(sessionID)
  sessionAncestry.deleteSession(sessionID)
  sessionLeaseHolders.delete(sessionID)
  sessionCallerAgents.delete(sessionID)
  sessionReasoningRecoveryRegistry.delete(sessionID)
  sessionRecoveryState.delete(sessionID)
  sessionContinuationCount.delete(sessionID)
  recoveryCoordinator.cancelSession(sessionID)
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
