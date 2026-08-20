/**
 * FlowDeck Session State & Lifecycle Registry
 *
 * Centralized in-memory registry for session metrics, child-task correlation,
 * pending slots, watchdog tracking, and lifecycle cleanup.
 */

import type { LoopDetector } from "./loop-detector"
import type { RecoverableFlowDeckBlockError } from "./recoverable-block"
import type { SessionRecoveryState } from "./reasoning-recovery"
import { clearWatchdogState } from "./heidi-watchdog"
import { watchdogIncidentManager } from "./watchdog-incident"
import { loopIncidentTracker } from "./loop-incident"
import { clearToolErrorCounts, orchestratorGuardStrategyCircuit } from "./orchestrator-guard-strategy-circuit"
import { semanticConvergenceGuard as semanticConvergence } from "./semantic-convergence-guard"
import { emptyTerminalCircuit } from "./empty-terminal-circuit"
import { taskPhaseManager } from "./task-phase-manager"
import { sessionAncestry } from "./session-ancestry"
import { recoveryCoordinator } from "./recovery-coordinator"
import { clearWriteCounter } from "../hooks/tool-guard"
import type { ShellFailureTracker } from "./shell-failure"
import type { OperationLifecycle } from "./operation-lifecycle"

export interface RuntimeSessionMetadata {
  sessionID: string
  parentID?: string
  agent?: string
  depth: number
}

export interface ChildTaskCorrelation {
  parentSessionID: string
  callID: string
  taskKey: string
  targetAgent: string
}

// ─── Session Metrics and Lifecycle State Maps ──────────────────────────────
export const sessionToolCalls = new Map<string, number>()
export const sessionRetries = new Map<string, number>()
export const sessionDelegations = new Map<string, number>()
export const sessionBlocks = new Map<string, number>()
export const sessionRecoverableBlocks = new Map<string, RecoverableFlowDeckBlockError>()
export const sessionReasoningRecoveryRegistry = new Map<string, Set<string>>()
export const sessionAutoContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>()
export const sessionRecoveryState = new Map<string, SessionRecoveryState>()
export const sessionContinuationCount = new Map<string, number>()
export const sessionWarnings = new Map<string, number>()
export const sessionStartTimes = new Map<string, number>()
export const sessionActiveTools = new Map<string, number>()
export const sessionFilesChanged = new Map<string, Set<string>>()
/** Timestamp of last MANUAL user message per session, for preflight hasNewerUserMessage check. */
export const sessionLastManualUserAt = new Map<string, number>()
/** Whether the session is in a cancelled/interrupted state. */
export const sessionIsCancelled = new Map<string, boolean>()

export const sessionRegistry = new Map<string, RuntimeSessionMetadata>()
export const sessionCallerAgents = new Map<string, string>()
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
export const pendingChildSlots = new Map<string, ChildTaskCorrelation[]>()

// ─── Production-hardening per-session runtime state ──────────────────────
export const sessionLoopIncidents = new Map<string, Set<string>>()
export const sessionLeaseHolders = new Map<string, string>()
export const sessionParallelWakeActive = new Set<string>()
export const activeLoopDetectors = new Set<LoopDetector>()

export function enqueuePendingSlot(
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
export function dequeuePendingSlot(
  parentSessionID: string,
  effectiveTarget?: string,
): { correlation: ChildTaskCorrelation | null; ambiguous: boolean } {
  if (effectiveTarget && effectiveTarget !== "unknown") {
    // Exact agent match
    const key = `${parentSessionID}:${effectiveTarget}`
    const queue = pendingChildSlots.get(key)
    if (queue && queue.length > 0) {
      if (queue.length > 1) {
        return { correlation: null, ambiguous: true }
      }
      const correlation = queue.shift()!
      if (queue.length === 0) pendingChildSlots.delete(key)
      return { correlation, ambiguous: false }
    }
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

  const agentKey = `${parentSessionID}:${found!.targetAgent}`
  const agentQueue = pendingChildSlots.get(agentKey)
  const correlation = agentQueue?.shift() ?? null
  if (agentQueue?.length === 0) pendingChildSlots.delete(agentKey)
  return { correlation, ambiguous: false }
}

export function cleanupPendingSlots(sessionID: string): void {
  for (const [key, queue] of pendingChildSlots.entries()) {
    if (key.startsWith(`${sessionID}:`)) {
      const remaining = queue.filter(c => c.parentSessionID !== sessionID)
      if (remaining.length === 0) {
        pendingChildSlots.delete(key)
      } else {
        pendingChildSlots.set(key, remaining)
      }
    }
  }
}

export function cleanupSessionState(
  sessionID: string,
  ld?: LoopDetector,
  trackers?: {
    shellFailureTracker?: ShellFailureTracker
    operationLifecycle?: OperationLifecycle
  }
): void {
  if (!sessionID) return
  if (ld) {
    ld.clearSession(sessionID)
  }
  for (const activeLd of activeLoopDetectors) {
    activeLd.clearSession(sessionID)
  }
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
  trackers?.shellFailureTracker?.clearSession(sessionID)
  trackers?.operationLifecycle?.clearSession(sessionID)
  orchestratorGuardStrategyCircuit.clearSession(sessionID)
  clearToolErrorCounts(sessionID)
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
  sessionTaskCalls.delete(sessionID)
  for (const key of sessionTaskCalls.keys()) {
    if (key.startsWith(`${sessionID}:`)) {
      sessionTaskCalls.delete(key)
    }
  }
  childSessionToTask.delete(sessionID)
  for (const [childId, corr] of childSessionToTask.entries()) {
    if (corr.parentSessionID === sessionID) {
      childSessionToTask.delete(childId)
    }
  }
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
