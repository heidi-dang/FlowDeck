/**
 * Token Optimization & Context Hygiene Service
 *
 * Implements token-saving defaults, context payload formatting,
 * token-optimizer MCP routing, repo-memory structural alignment,
 * and stage-boundary session hygiene.
 */

import type { McpAvailability } from "../mcp/index"
import { selectToolFamily, shouldActivateTokenOptimization, type ToolFamily } from "./tool-selection-policy"

export interface ContextPacketInput {
  target: string
  blastRadius?: string
  patterns?: string[]
  priorLessons?: string
  constraints?: string
  stage: string
}

export const MAX_CONTEXT_PACKET_TOKENS = 400
export const MAX_CONTEXT_PACKET_CHARS = 1600

/**
 * Format a compact context packet for agent handoffs.
 * Guarantees total size remains strictly under 400 tokens (~1600 characters).
 */
export function formatContextPacket(input: ContextPacketInput): string {
  const lines: string[] = [
    "## Orchestrator Context",
    `Target: ${input.target}`,
  ]

  if (input.blastRadius) {
    lines.push(`Blast radius: ${input.blastRadius}`)
  }

  if (input.patterns && input.patterns.length > 0) {
    lines.push(`Patterns: ${input.patterns.slice(0, 3).join("; ")}`)
  }

  if (input.priorLessons) {
    lines.push(`Prior lessons: ${input.priorLessons}`)
  }

  if (input.constraints) {
    lines.push(`Constraints: ${input.constraints}`)
  }

  lines.push(`Stage: ${input.stage}`)

  let formatted = lines.join("\n")
  if (formatted.length > MAX_CONTEXT_PACKET_CHARS) {
    formatted = formatted.slice(0, MAX_CONTEXT_PACKET_CHARS - 3) + "..."
  }

  return formatted
}

export interface ContextReadInput {
  filePath: string
  totalLines?: number
  estimatedTokens?: number
  startLine?: number
  endLine?: number
  availability?: McpAvailability[]
}

export interface ContextReadResult {
  action: "token_optimizer" | "targeted_read" | "outline_search"
  toolFamily: ToolFamily | null
  recommendedStartLine?: number
  recommendedEndLine?: number
  reason: string
}

/**
 * Route context reads using token-saving policy defaults.
 * Automatically routes large text reads through token-optimizer when present,
 * or returns narrow line bounds / outline search fallbacks.
 */
export function routeContextRead(input: ContextReadInput): ContextReadResult {
  const estimatedTokens = input.estimatedTokens ?? (input.totalLines ? input.totalLines * 10 : 500)
  const availability = input.availability ?? []

  // Check if token-optimizer MCP is available and should be activated
  const tokenOptFamily = shouldActivateTokenOptimization(estimatedTokens, 1000, availability)
  if (tokenOptFamily) {
    return {
      action: "token_optimizer",
      toolFamily: tokenOptFamily,
      reason: `Routing to token-optimizer: estimated ${estimatedTokens} tokens >= threshold 1000`,
    }
  }

  // Large file without token-optimizer -> prefer narrow line bounds or outline
  if (input.totalLines && input.totalLines > 200 && (!input.startLine || !input.endLine)) {
    return {
      action: "targeted_read",
      toolFamily: selectToolFamily({ intent: "general", availability }).primary,
      recommendedStartLine: 1,
      recommendedEndLine: Math.min(input.totalLines, 100),
      reason: `Large file (${input.totalLines} lines) — applying narrow line bounds (1-100)`,
    }
  }

  return {
    action: "targeted_read",
    toolFamily: selectToolFamily({ intent: "general", availability }).primary,
    recommendedStartLine: input.startLine,
    recommendedEndLine: input.endLine,
    reason: "Standard targeted read",
  }
}

/**
 * Session Context Hygiene Tracker.
 * Manages active session context snapshots and prunes stale/duplicate
 * file body dumps at stage boundaries.
 */
export class SessionContextHygiene {
  private sessionDumps: Map<string, Set<string>> = new Map()

  recordDump(sessionID: string, dumpKey: string): void {
    const dumps = this.sessionDumps.get(sessionID) ?? new Set()
    dumps.add(dumpKey)
    this.sessionDumps.set(sessionID, dumps)
  }

  getDumpCount(sessionID: string): number {
    return this.sessionDumps.get(sessionID)?.size ?? 0
  }

  /**
   * Prune session context memory at stage boundaries (e.g. fd-task -> fd-execute).
   */
  pruneStageBoundaryContext(sessionID: string, newStage: string): { prunedCount: number; stage: string } {
    const dumps = this.sessionDumps.get(sessionID)
    const count = dumps?.size ?? 0
    this.sessionDumps.delete(sessionID)
    return {
      prunedCount: count,
      stage: newStage,
    }
  }

  clearSession(sessionID: string): void {
    this.sessionDumps.delete(sessionID)
  }
}
