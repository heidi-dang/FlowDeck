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
  runtimeProjection?: string
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
  if (input.runtimeProjection) prompt += `\nRuntime Projection:\n${input.runtimeProjection}`

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
  /** Number of verified facts / decisions retained in the summary. */
  retainedFactsCount: number
  /** Number of explicit decisions retained (subset of retainedFactsCount). */
  retainedDecisionsCount: number
  /** Number of acceptance criteria retained. */
  retainedCriteriaCount: number
  /** Number of file paths tracked. */
  retainedFilesCount: number
  /** Fractional token reduction achieved (0–1). */
  reductionRatio: number
}

const COMPACT_MARKER = "## Compacted Execution State"

// ── Compaction state accumulator ──────────────────────────────────────────────

interface CompactionState {
  initialGoal: string
  acceptanceCriteria: Set<string>
  architecturalConstraints: Set<string>
  verifiedFacts: Set<string>
  unresolvedFailures: Set<string>
  files: Set<string>
  artifacts: Set<string>
  compactionCount: number
}

function newCompactionState(seedFiles?: string[]): CompactionState {
  return {
    initialGoal: "",
    acceptanceCriteria: new Set(),
    architecturalConstraints: new Set(),
    verifiedFacts: new Set(),
    unresolvedFailures: new Set(),
    files: new Set(seedFiles ?? []),
    artifacts: new Set(),
    compactionCount: 0,
  }
}

/**
 * Parse a previously formatted "## Compacted Execution State" block back into
 * the accumulator. Preserves initial goal, criteria, constraints, facts, etc.
 */
function parseCompactedStateFromText(text: string, state: CompactionState): void {
  for (const line of text.split("\n")) {
    const goalMatch = line.match(/^[-*]\s+Initial Goal:\s*(.*)/i)
    if (goalMatch?.[1] && !state.initialGoal) {
      state.initialGoal = goalMatch[1].trim()
      continue
    }

    const criteriaMatch = line.match(/^[-*]\s+Acceptance Criteria:\s*(.*)/i)
    if (criteriaMatch?.[1]) {
      for (const p of criteriaMatch[1].split(";").map(s => s.trim()).filter(Boolean)) {
        if (p !== "None specified" && state.acceptanceCriteria.size < 10) state.acceptanceCriteria.add(p)
      }
      continue
    }

    const constraintsMatch = line.match(/^[-*]\s+Architectural Constraints:\s*(.*)/i)
    if (constraintsMatch?.[1]) {
      for (const p of constraintsMatch[1].split(";").map(s => s.trim()).filter(Boolean)) {
        if (p !== "Standard surgical rules apply" && state.architecturalConstraints.size < 5) state.architecturalConstraints.add(p)
      }
      continue
    }

    const factsMatch = line.match(/^[-*]\s+Verified Facts(?:\s*&\s*Decisions)?:\s*(.*)/i)
    if (factsMatch?.[1]) {
      for (const p of factsMatch[1].split(";").map(s => s.trim()).filter(Boolean)) {
        if (p !== "Execution in progress" && state.verifiedFacts.size < 10) state.verifiedFacts.add(p)
      }
      continue
    }

    const failuresMatch = line.match(/^[-*]\s+Unresolved Failures:\s*(.*)/i)
    if (failuresMatch?.[1]) {
      for (const p of failuresMatch[1].split(";").map(s => s.trim()).filter(Boolean)) {
        if (p !== "None" && state.unresolvedFailures.size < 5) state.unresolvedFailures.add(p)
      }
      continue
    }

    const filesMatch = line.match(/^[-*]\s+Files Touched \/ Relevant:\s*(.*)/i)
    if (filesMatch?.[1]) {
      for (const p of filesMatch[1].split(",").map(s => s.trim()).filter(Boolean)) {
        if (p !== "None specified" && state.files.size < 15) state.files.add(p)
      }
      continue
    }

    const artifactsMatch = line.match(/^[-*]\s+Externalized Artifacts:\s*(.*)/i)
    if (artifactsMatch?.[1]) {
      for (const p of artifactsMatch[1].split(",").map(s => s.trim()).filter(Boolean)) {
        if (p !== "None" && state.artifacts.size < 20) state.artifacts.add(p)
      }
      continue
    }

    const phaseMatch = line.match(/^[-*]\s+Compaction Phase:\s*(\d+)/i)
    if (phaseMatch) {
      state.compactionCount = Math.max(state.compactionCount, parseInt(phaseMatch[1], 10))
    }
  }
}

/** Extract engineering signals from a non-summary conversation turn. */
function extractFromTurn(turn: ConversationTurn, state: CompactionState): void {
  const text = typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content ?? "")

  // Initial goal from first user turn
  if (turn.role === "user" && !state.initialGoal) {
    state.initialGoal = text.split("\n")[0].slice(0, 200).trim()
  }

  // File references
  for (const match of text.matchAll(/(?:src|tests|crates|docs)\/[a-zA-Z0-9_\-./]+|package\.json|Cargo\.toml|tsconfig\.json/g)) {
    if (state.files.size < 15) state.files.add(match[0])
  }

  // Externalized artifact references
  for (const match of text.matchAll(/art-[a-z-]+-[0-9a-f]{12}/g)) {
    if (state.artifacts.size < 20) state.artifacts.add(match[0])
  }

  const lines = text.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Decisions / Verified facts. "Conclusion:" lines are turn summaries, not
    // facts or decisions — excluding them keeps the cap for real signals.
    if (/Decision:|Verified:|Passed:/.test(trimmed) && state.verifiedFacts.size < 10) {
      state.verifiedFacts.add(trimmed.slice(0, 120))
    }
    // Acceptance criteria
    if (
      (/Acceptance Criteria:|Acceptance:/i.test(trimmed) || trimmed.startsWith("- [ ]") || trimmed.startsWith("- [x]")) &&
      state.acceptanceCriteria.size < 10
    ) {
      state.acceptanceCriteria.add(trimmed.slice(0, 120))
    }
    // Architectural constraints
    if (/Constraint:|Architectural constraint:|Non-negotiable:/i.test(trimmed) && state.architecturalConstraints.size < 5) {
      state.architecturalConstraints.add(trimmed.slice(0, 120))
    }
    // Unresolved failures (skip lines that indicate success)
    if (
      /FAILED:|FAIL\b|Exception:/i.test(trimmed) &&
      !/no error|zero error|0 error|0 fail|passed/i.test(trimmed) &&
      state.unresolvedFailures.size < 5
    ) {
      state.unresolvedFailures.add(trimmed.slice(0, 120))
    }
  }
}

/** Format the accumulated compaction state into the canonical summary block. */
function formatCompactionSummary(state: CompactionState): string {
  const goal = state.initialGoal || "Execute delegated task"
  const criteria =
    state.acceptanceCriteria.size > 0 ? Array.from(state.acceptanceCriteria).join("; ") : "None specified"
  const constraints =
    state.architecturalConstraints.size > 0
      ? Array.from(state.architecturalConstraints).join("; ")
      : "Standard surgical rules apply"
  const facts =
    state.verifiedFacts.size > 0 ? Array.from(state.verifiedFacts).join("; ") : "Execution in progress"
  const failures = state.unresolvedFailures.size > 0 ? Array.from(state.unresolvedFailures).join("; ") : "None"
  const files =
    state.files.size > 0 ? Array.from(state.files).slice(0, 15).join(", ") : "None specified"
  const artifacts =
    state.artifacts.size > 0 ? Array.from(state.artifacts).slice(0, 20).join(", ") : "None"
  const phase = state.compactionCount + 1

  return `${COMPACT_MARKER}
- Initial Goal: ${goal}
- Acceptance Criteria: ${criteria}
- Architectural Constraints: ${constraints}
- Verified Facts & Decisions: ${facts}
- Unresolved Failures: ${failures}
- Files Touched / Relevant: ${files}
- Externalized Artifacts: ${artifacts}
- Compaction Phase: ${phase}`
}

/**
 * Deterministically compact conversation history turns when estimated
 * conversation tokens exceed thresholdTokens.
 *
 * Compaction preserves the system message / prompt and the most recent 2–4
 * active turns, while compressing obsolete intermediate turns into a single
 * structured execution-state block.
 *
 * Re-compaction is safe: existing summary blocks in obsolete turns are parsed
 * to preserve initial goals, acceptance criteria, verified facts, and artifact
 * references. Existing summary turns in the recent window are filtered out to
 * prevent nested summaries.
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
      retainedFactsCount: 0,
      retainedDecisionsCount: 0,
      retainedCriteriaCount: 0,
      retainedFilesCount: 0,
      reductionRatio: 0,
    }
  }

  // Separate system message (index 0 if role === "system")
  const systemMsg = opts.messages.length > 0 && opts.messages[0].role === "system" ? opts.messages[0] : null
  const startIndex = systemMsg ? 1 : 0

  // Keep the most recent 2–4 active messages
  const recentCount = Math.min(4, Math.max(2, Math.floor(opts.messages.length / 3)))
  const activeIndex = Math.max(startIndex, opts.messages.length - recentCount)

  const obsoleteTurns = opts.messages.slice(startIndex, activeIndex)

  // Filter existing compaction-summary turns from the recent window to prevent
  // nested summaries when the active window happens to include a prior summary.
  const recentTurns = opts.messages
    .slice(activeIndex)
    .filter(t => {
      const text = typeof t.content === "string" ? t.content : ""
      return !text.includes(COMPACT_MARKER)
    })

  // ── Accumulate compaction state from all obsolete turns ─────────────────
  const state = newCompactionState(opts.modifiedFiles)

  for (const turn of obsoleteTurns) {
    const text = typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content ?? "")
    if (text.includes(COMPACT_MARKER)) {
      // Parse previously formatted summary to carry forward knowledge
      parseCompactedStateFromText(text, state)
    } else {
      extractFromTurn(turn, state)
    }
  }

  // ── Build summary turn ────────────────────────────────────────────────────
  const summaryTurn: ConversationTurn = {
    role: "user",
    content: formatCompactionSummary(state),
  }

  const compactedMessages: ConversationTurn[] = []
  if (systemMsg) compactedMessages.push(systemMsg)
  compactedMessages.push(summaryTurn)
  compactedMessages.push(...recentTurns)

  const compactedTokens = estimateReplayTokens(compactedMessages)
  const reductionRatio = originalTokens > 0 ? Math.max(0, 1 - compactedTokens / originalTokens) : 0

  const retainedDecisionsCount = Array.from(state.verifiedFacts).filter(f => /Decision:/i.test(f)).length

  return {
    messages: compactedMessages,
    compacted: true,
    originalTokens,
    compactedTokens,
    compactionCount: state.compactionCount + 1,
    retainedFactsCount: state.verifiedFacts.size,
    retainedDecisionsCount,
    retainedCriteriaCount: state.acceptanceCriteria.size,
    retainedFilesCount: state.files.size,
    reductionRatio,
  }
}
