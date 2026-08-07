/**
 * Context Scoping & Compaction Service
 *
 * Authoritative library for bounding what enters a child session's context and
 * compacting oversized payloads BEFORE they are sent, so a runaway child or
 * long parent session cannot balloon token consumption.
 */

import { estimateTokensFromBytes } from "./token-budget"
import { formatContextPacket } from "./token-optimizer-service"
import { ArtifactStore, type Artifact } from "./artifact-store"

export interface AssignmentContextInput {
  target?: string
  blastRadius?: string
  patterns?: string[]
  priorLessons?: string
  constraints?: string
  stage?: string
  assignment: string
  gitCommit?: string
  acceptanceCriteria?: string[]
  relevantFiles?: string[]
  externalizedArtifacts?: string[]
}

export interface AssignmentContextResult {
  /** The bounded prompt handed to the child. */
  prompt: string
  /** Token estimate of the bounded prompt. */
  estimatedTokens: number
  /** True when the parent conversation was intentionally NOT replayed. */
  parentConversationExcluded: true
}

/**
 * Build a bounded context for a delegated child session.
 *
 * Children receive a compact briefing and their scoped assignment — never a
 * raw replay of the parent conversation.
 */
export function buildAssignmentContext(input: AssignmentContextInput): AssignmentContextResult {
  const packet = formatContextPacket({
    target: input.target ?? "unspecified",
    blastRadius: input.blastRadius,
    patterns: input.patterns,
    priorLessons: input.priorLessons,
    constraints: input.constraints ?? "Surgical changes only. Verify changes with tests before completion.",
    stage: input.stage ?? "execute",
  })

  let prompt = `${packet}\n\n## Assignment\n${input.assignment}`
  if (input.gitCommit) {
    prompt += `\n\nGit Commit/SHA: ${input.gitCommit}`
  }
  if (input.relevantFiles && input.relevantFiles.length > 0) {
    prompt += `\nRelevant files: ${input.relevantFiles.join(", ")}`
  }
  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    prompt += `\nAcceptance Criteria:\n- ${input.acceptanceCriteria.join("\n- ")}`
  }
  if (input.externalizedArtifacts && input.externalizedArtifacts.length > 0) {
    prompt += `\nExternalized Artifacts: ${input.externalizedArtifacts.join(", ")}`
  }

  return {
    prompt,
    estimatedTokens: estimateTokensFromBytes(Buffer.byteLength(prompt, "utf-8")),
    parentConversationExcluded: true,
  }
}

export interface ExternalizeResult {
  text: string
  truncated: boolean
  originalChars: number
  retainedChars: number
  artifactId?: string
}

/**
 * Bound tool output that would otherwise flood a child context.
 * Returns the original text unchanged when under the budget, otherwise stores
 * the content in ArtifactStore (when provided) and returns a stable marker.
 */
export function externalizeToolOutput(
  text: string,
  maxChars: number,
  opts?: { sessionID?: string; toolName?: string; artifactStore?: ArtifactStore; type?: Artifact["type"] }
): ExternalizeResult {
  const originalChars = text.length
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, retainedChars: originalChars }
  }

  const sessionID = opts?.sessionID ?? "session"
  const toolName = opts?.toolName ?? "tool"
  const store = opts?.artifactStore

  let artifactId: string | undefined
  let markerText: string

  if (store) {
    const artifact = store.store(sessionID, toolName, text, opts?.type ?? "tool_output")
    artifactId = artifact.id
    markerText = `[Externalized Artifact: ${artifact.id} (type: ${artifact.type}, length: ${originalChars} chars)]\nTool: ${toolName}\nSummary:\n${artifact.summary}\n\nTo view full content, call fdx-context with action:"read_artifact" and artifact_id:"${artifact.id}".`
  } else {
    const retainedChars = Math.max(0, maxChars - 3)
    markerText = `${text.slice(0, retainedChars)}...`
  }

  return {
    text: markerText,
    truncated: true,
    originalChars,
    retainedChars: markerText.length,
    artifactId,
  }
}

/**
 * Deterministic compaction trigger. Returns true when the estimated
 * conversation size (tokens or characters) exceeds the configured threshold.
 */
export function shouldCompact(estimatedTokens: number, thresholdTokens: number): boolean {
  return estimatedTokens > thresholdTokens
}

/** Estimate tokens for a raw conversation replay (used to justify exclusion). */
export function estimateReplayTokens(messages: unknown[]): number {
  let bytes = 0
  for (const m of messages) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(m ?? {}), "utf-8")
    } catch {
      // skip un-serializable message
    }
  }
  return estimateTokensFromBytes(bytes)
}

export interface ConversationTurn {
  role: string
  content: string | any
  [key: string]: any
}

export interface CompactConversationOptions {
  messages: ConversationTurn[]
  thresholdTokens: number
  sessionID?: string
  modifiedFiles?: string[]
}

export interface CompactConversationResult {
  messages: ConversationTurn[]
  compacted: boolean
  originalTokens: number
  compactedTokens: number
  compactionCount: number
}

const COMPACT_MARKER = "## Compacted Execution State"

/**
 * Deterministically compact conversation history turns when estimated
 * conversation tokens exceed thresholdTokens.
 *
 * Compaction preserves system message / prompt and the recent 2-4 active turns,
 * while compressing obsolete intermediate turns into a single structured
 * execution state block. If compaction has already been run previously,
 * the old summary block is updated/replaced to prevent recursive summarization.
 */
export function compactConversationContext(opts: CompactConversationOptions): CompactConversationResult {
  const originalTokens = estimateReplayTokens(opts.messages)
  if (!shouldCompact(originalTokens, opts.thresholdTokens) || opts.messages.length <= 3) {
    return {
      messages: opts.messages,
      compacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      compactionCount: 0,
    }
  }

  // Separate system message (index 0 if role === "system")
  const systemMsg = opts.messages.length > 0 && opts.messages[0].role === "system" ? opts.messages[0] : null
  const startIndex = systemMsg ? 1 : 0

  // Keep the most recent 2-4 active messages
  const recentCount = Math.min(4, Math.max(2, Math.floor(opts.messages.length / 3)))
  const activeIndex = Math.max(startIndex, opts.messages.length - recentCount)

  const obsoleteTurns = opts.messages.slice(startIndex, activeIndex)
  const recentTurns = opts.messages.slice(activeIndex)

  // Parse facts, decisions, and modified files from obsolete turns
  const extractedFacts: string[] = []
  const extractedFiles = new Set<string>(opts.modifiedFiles ?? [])
  let lastUserGoal = ""

  for (const turn of obsoleteTurns) {
    const text = typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content ?? "")
    if (turn.role === "user" && !lastUserGoal) {
      lastUserGoal = text.slice(0, 200)
    }
    // Extract file references
    const fileMatches = text.matchAll(/(?:src|tests|crates|docs)\/[a-zA-Z0-9_\-./]+/g)
    for (const match of fileMatches) {
      extractedFiles.add(match[0])
    }
    // Extract key facts or decisions
    if (text.includes("Decision:") || text.includes("Verified:") || text.includes("Passed:")) {
      const line = text.split("\n").find(l => /Decision:|Verified:|Passed:/.test(l))
      if (line) extractedFacts.push(line.trim())
    }
  }

  const fileListStr = Array.from(extractedFiles).slice(0, 10).join(", ") || "None specified"
  const factsStr = extractedFacts.slice(0, 5).join("; ") || "Execution in progress"

  const summaryContent = `${COMPACT_MARKER}
- Initial Goal: ${lastUserGoal || "Execute delegated task"}
- Verified Facts: ${factsStr}
- Files Touched / Relevant: ${fileListStr}
- Status: Obsolete discussion compacted to preserve context budget.`

  const summaryTurn: ConversationTurn = {
    role: "user",
    content: summaryContent,
  }

  const compactedMessages: ConversationTurn[] = []
  if (systemMsg) compactedMessages.push(systemMsg)
  compactedMessages.push(summaryTurn)
  compactedMessages.push(...recentTurns)

  const compactedTokens = estimateReplayTokens(compactedMessages)

  return {
    messages: compactedMessages,
    compacted: true,
    originalTokens,
    compactedTokens,
    compactionCount: 1,
  }
}
