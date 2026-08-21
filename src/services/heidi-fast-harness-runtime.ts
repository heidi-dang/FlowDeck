/**
 * HeidiFastHarnessRuntime — live integration facade for Fast Harness v1.
 *
 * Owns the per-session route decision, task state lifecycle, per-turn
 * provider-context rendering, and performance telemetry used by the
 * OpenCode plugin hooks in src/index.ts.
 *
 * Invariants:
 *  - Only genuine MANUAL user turns are classified. Internal continuation /
 *    recovery prompts never reclassify and never reset route state.
 *  - Resuming an unresolved task preserves its route decision and task state.
 *  - The permanent Heidi core prompt stays static; only task-specific
 *    sections are injected per turn.
 *  - No chain-of-thought is recorded in telemetry.
 */

import { classifyTask, stableHash, type RouterDecision } from "./heidi-fast-router"
import { createTaskState, getTaskState } from "./heidi-task-state"
import {
  setRouteDecision,
  getRouteDecision,
  shouldPreserveRoute,
  noteInternalContinuation,
  touchRouteActivity,
  clearRouteDecision,
} from "./heidi-route-state"
import { renderParallelPacket } from "./heidi-parallel-context"
import { getRepositoryContext, renderHotContextSummary, invalidateRepositoryContext } from "./repository-hot-context"
import { getCachedConfig } from "./config-cache"
import type { GovernanceMode } from "./governance-fast-path"

import { buildTaskSpecificPromptSections, estimateCorePromptTokens } from "../agents/orchestrator"
import { createTracker, getTracker, clearTracker } from "./heidi-performance"

export interface TurnRouteResult {
  sessionID: string
  taskId: string
  decision: RouterDecision | null
  resumed: boolean
  isNewTask: boolean
  provenance: string
}

let _taskIdCounter = 0

/**
 * Cached governance-mode resolution — same semantics as resolveGovernanceMode
 * (config.governance?.mode ?? config.governance?.validator?.mode, default
 * advisory) but reads the ConfigCache hot index instead of re-parsing the
 * config file on every call.
 */
export function resolveGovernanceModeCached(directory: string): GovernanceMode {
  const config = getCachedConfig(directory)
  const mode = config.governance?.mode ?? config.governance?.validator?.mode
  if (mode === "off" || mode === "advisory" || mode === "strict") return mode
  return "advisory"
}

/**
 * Handle a genuine manual user message: classify once, store the route
 * decision keyed by session/current user turn, create/update task state.
 * Never called for internal continuation prompts.
 */
export async function handleUserMessage(
  sessionID: string,
  taskText: string,
  directory: string,
): Promise<TurnRouteResult> {
  const h = stableHash(taskText)
  const existing = getRouteDecision(sessionID)
  const preserve = existing ? shouldPreserveRoute(sessionID, h) : { preserve: false }

  if (preserve.preserve && existing) {
    const tracker = getTracker(existing.taskId) ?? createTracker(existing.taskId, sessionID)
    // Resume the existing unresolved task: keep the prior route decision and task state.
    const spanKey = tracker.startSpan("routing", { resumed: true })
    const st = getTaskState(existing.taskId)
    st?.setPhase("execute")
    st?.setNextAction("Continue previous task with the user follow-up.")
    touchRouteActivity(sessionID)
    tracker.endSpan(spanKey)
    return {
      sessionID,
      taskId: existing.taskId,
      decision: existing.decision,
      resumed: true,
      isNewTask: false,
      provenance: "manual_user",
    }
  }

  // Fresh manual task: classify BEFORE expensive repository discovery.
  const taskId = `task-${sessionID}-${Date.now().toString(36)}-${++_taskIdCounter}`
  const tracker = createTracker(taskId, sessionID)
  const spanKey = tracker.startSpan("routing", {
    confidence: 0,
    reasonCode: "pending",
  })
  const decision = classifyTask(taskText)
  const state = createTaskState(taskId, taskText.slice(0, 200), decision.executionClass)
  state.setPhase("routing")
  state.addVerifiedFact(`Routed as ${decision.executionClass}`)
  state.setNextAction(decision.executionClass === "SPECIALIST" || decision.executionClass === "PARALLEL_SPECIALISTS"
    ? `Delegate to ${(decision.suggestedAgents ?? []).join(", ")} on turn 1.`
    : "Begin direct execution with lean context.")
  setRouteDecision(sessionID, taskId, decision, taskText.slice(0, 200), h)
  tracker.setExecutionClass(decision.executionClass)
  tracker.endSpan(spanKey)

  // Warm the repository hot context and prefetch the manifest set with
  // CONCURRENT reads (ReadBatchService in the live path) for classes that
  // need discovery. Independent reads run in parallel; nothing blocking.
  if (decision.executionClass === "STANDARD" || decision.executionClass === "DEEP") {
    try {
      getRepositoryContext(directory)
    } catch (err) {
      console.debug?.("[FastHarness] opportunistic repository discovery error:", err)
    }
    try {
      const packet = await prefetchRepositoryBatch(directory)
      if (packet.indexOf("unavailable") === -1) {
        state.addVerifiedFact(packet.slice(0, 120))
      }
    } catch (err) {
      console.debug?.("[FastHarness] opportunistic prefetchRepositoryBatch error:", err)
    }
  }

  return {
    sessionID,
    taskId,
    decision,
    resumed: false,
    isNewTask: true,
    provenance: "manual_user",
  }
}

/**
 * Record an internal continuation prompt. Does NOT reclassify and does NOT
 * reset route state — this is what keeps automatic Continue from resetting
 * the per-user-task route decision.
 */
export function handleInternalContinuation(sessionID: string): void {
  noteInternalContinuation(sessionID)
}

/**
 * Render the per-turn lazy context injected by experimental.chat.system.transform:
 *  - compact task-state packet (<200 tokens)
 *  - repository hot-context summary
 *  - task-specific prompt sections for the turn execution class
 * Returns "" when no active route exists (e.g. plain chat, no task).
 */
export function renderTurnContext(sessionID: string, directory: string): string {
  const route = getRouteDecision(sessionID)
  if (!route) return ""
  const parts: string[] = []
  const st = getTaskState(route.taskId)
  if (st) parts.push(st.renderContextPacket())
  try {
    parts.push(renderHotContextSummary(getRepositoryContext(directory)))
  } catch (err) {
    // Repository facts are best-effort — never break the prompt build.
    console.debug?.("[FastHarness] renderHotContextSummary error:", err)
  }
  const isCodeMode = process.env.OPENCODE_EXPERIMENTAL_CODE_MODE === "true" ||
    (process.env.OPENCODE_EXPERIMENTAL_CODE_MODE === undefined && process.env.OPENCODE_EXPERIMENTAL === "true")

  // Expose telemetry via console.debug for tests/telemetry parsing.
  if (route.decision.codeModeTelemetry?.codeModeConsidered) {
    console.debug?.("[FastHarness] CodeMode Telemetry:", JSON.stringify(route.decision.codeModeTelemetry))
  }

  // Capability is strictly evaluated; fallback to UNKNOWN if enabled but execute not positively observed.
  const codeModeCapability = isCodeMode ? "UNKNOWN" : "UNAVAILABLE"

  const sections = buildTaskSpecificPromptSections(
    route.decision.executionClass,
    route.decision.specialists,
    undefined,
    {
      codeModeCapability,
      mcpCompositionCandidate: route.decision.mcpCompositionCandidate,
      codeModeRejectedReason: route.decision.codeModeRejectedReason
    },
  )
  if (sections.trim()) parts.push(sections)
  // Active-parallel coordinator packet (compact <200 tokens; empty when none).
  try {
    const packet = renderParallelPacket(sessionID)
    if (packet.trim()) parts.push(packet)
  } catch (err) {
    // parallel packet is best-effort — never break prompt build
    console.debug?.("[FastHarness] renderParallelPacket error:", err)
  }
  return parts.join("\n\n")
}

/** Approximate token size of what renderTurnContext would add (benchmark aid). */
export function estimateTurnContextTokens(sessionID: string, directory: string): number {
  try {
    const ctx = renderTurnContext(sessionID, directory)
    return Math.round(ctx.length / 4)
  } catch (err) {
    console.debug?.("[FastHarness] estimateTurnContextTokens error:", err)
    return 0
  }
}

/**
 * Complete the current task: record final metrics, clear route + task state.
 * Returns the final tracker summary (safe: no prompt content).
 */
export function completeTask(sessionID: string): string | null {
  const route = getRouteDecision(sessionID)
  if (!route) return null
  const st = getTaskState(route.taskId)
  st?.setPhase("complete")
  st?.setVerificationState("passed")
  const tracker = getTracker(route.taskId)
  const summary = tracker?.summary() ?? null
  touchRouteActivity(sessionID)
  clearRouteDecision(sessionID)
  if (tracker) clearTracker(route.taskId)
  return summary
}

/** Record one model turn into the session tracker (tokens are structural, safe). */
export function recordModelTurn(sessionID: string, inputTokens: number, outputTokens: number, contextSizeTokens?: number): void {
  const route = getRouteDecision(sessionID)
  if (!route) return
  const tracker = getTracker(route.taskId)
  if (tracker) tracker.recordModelTurn(inputTokens, outputTokens, contextSizeTokens)
}

/** Record a tool call (parallel vs sequential flag) into the session tracker. */
export function recordToolCall(sessionID: string, isParallel: boolean): void {
  const route = getRouteDecision(sessionID)
  if (!route) return
  const tracker = getTracker(route.taskId)
  if (tracker) tracker.recordToolCall(isParallel)
}

/** Current core-prompt token estimate (used to prove lean live context). */
export function liveCorePromptTokens(): number {
  return estimateCorePromptTokens()
}

/** Force repository hot-context invalidation (HEAD/config/manifest change). */
export function invalidateRepoContext(directory: string): void {
  invalidateRepositoryContext(directory)
}

/** Test-only reset of the whole runtime facade. */

import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { executeBatchReads, type ReadOperation } from "./read-batch"

/**
 * Filesystem-backed read-batch executor: deterministic safe reads only.
 * Never performs writes — executeBatchReads rejects non-whitelisted tools.
 */
async function fsReadExecutor(tool: string, args: Record<string, unknown>): Promise<string> {
  const p = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : ""
  if (tool === "fdx-ls") {
    const d = typeof args.dir === "string" ? args.dir : p
    return existsSync(d) ? readdirSync(d).slice(0, 64).join("\n") : "MISSING"
  }
  if (tool === "fdx-read") {
    return existsSync(p) ? readFileSync(p, "utf-8") : "MISSING"
  }
  return "UNSUPPORTED"
}

/**
 * Live consumption of ReadBatchService: prefetch the stable repository
 * manifest set with CONCURRENT independent reads, returning a compact
 * structured packet (not concatenated giant outputs).
 */
export async function prefetchRepositoryBatch(directory: string): Promise<string> {
  const ops: ReadOperation[] = [
    { tool: "fdx-ls", args: { dir: directory }, label: "root-ls" },
    { tool: "fdx-read", args: { file_path: join(directory, "package.json") }, label: "package.json" },
    { tool: "fdx-read", args: { file_path: join(directory, "tsconfig.json") }, label: "tsconfig.json" },
    { tool: "fdx-read", args: { file_path: join(directory, ".flowdeck.json") }, label: ".flowdeck.json" },
  ]
  try {
    const batch = await executeBatchReads(ops, fsReadExecutor, { maxConcurrency: 4, timeoutMs: 2000, maxOutputBytes: 1600 })
    // Compact structured packet: label + kind + size/first-line only.
    const lines: string[] = []
    for (const r of batch.results) {
      if (r.error) {
        lines.push("err:" + (r.label ?? r.tool))
        continue
      }
      const content = typeof r.result === "string" ? r.result : JSON.stringify(r.result)
      if (content === "MISSING") { lines.push((r.label ?? r.tool) + ":absent"); continue }
      if (typeof r.result === "string") {
        lines.push((r.label ?? r.tool) + ":bytes=" + Buffer.byteLength(content, "utf-8"))
      } else {
        lines.push((r.label ?? r.tool) + ":present")
      }
    }
    return "[ReadBatch] " + lines.join(" | ")
  } catch (err) {
    console.debug?.("[FastHarness] prefetchRepositoryBatch error:", err)
    return "[ReadBatch] unavailable"
  }
}

/**
 * Record provider-safe lean-context metadata for a FAST_DIRECT turn: core
 * prompt token estimate + class. No chain-of-thought, no prompt content.
 */
export function markLeanContext(sessionID: string): string {
  const route = getRouteDecision(sessionID)
  if (!route) return ""
  const tracker = getTracker(route.taskId)
  const coreTokens = estimateCorePromptTokens()
  if (tracker) {
    tracker.startSpan("provider.request", {
      executionClass: route.decision.executionClass,
      leanContext: route.decision.executionClass === "FAST_DIRECT" ? 1 : 0,
      corePromptTokens: coreTokens,
      specialistDirectorySkipped: route.decision.executionClass === "FAST_DIRECT" ? 1 : 0,
    })
  }
  return "lean=" + (route.decision.executionClass === "FAST_DIRECT" ? "1" : "0") + ":core=" + coreTokens
}

export function _resetFastHarnessRuntime(): void {
  const { _resetRouteState } = require("./heidi-route-state") as typeof import("./heidi-route-state")
  _resetRouteState()
}