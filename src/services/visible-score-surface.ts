/**
 * FlowDeck visible score surface.
 *
 * Bridges the RuntimeSelfAudit integrity score to the OpenCode TUI WITHOUT ever
 * leaking scored metadata into the provider-visible (model-visible) transcript.
 *
 * The TUI renders the returned `title` as the operation's header (e.g.
 * "Shell npm test — FlowDeck 96%"). All scored detail lives in `metadata`
 * under `fd.selfAudit`, which the model never sees. Explanations are always
 * short, generic strings — never hidden reasoning text or conversation content.
 */

/**
 * The class of runtime action being scored. Mirrors the TUI's operation kinds.
 */
export type ScoreActionClass =
  | "think"
  | "tool"
  | "fdx"
  | "shell"
  | "delegation"
  | "recovery"
  | "assistant_completion"

/**
 * A single visible score annotation. The TUI renders `title`; `metadata`
 * carries the scored detail for the UI layer (and is stripped before anything
 * model-visible is produced).
 */
export interface ScoreAnnotation {
  title: string
  metadata: Record<string, unknown>
}

export interface BuildScoreAnnotationInput {
  actionClass: ScoreActionClass
  sessionID: string
  label: string
  score: number
  explanation?: string
}

/** Scores at or above this threshold are considered "high" with no explanation. */
const HIGH_SCORE_CUTOFF = 60

/**
 * Fixed, generic, short explanations per action class. These are hand-written
 * constants — they can never carry hidden reasoning text or conversation
 * content, and each is well under the 140-char cap.
 */
const GENERIC_REASONS: Record<ScoreActionClass, string> = {
  think: "Reduced reasoning-integrity",
  tool: "Tool execution integrity shortfall",
  fdx: "FDX integrity shortfall",
  shell: "Shell integrity shortfall",
  delegation: "Delegation provenance mismatch",
  recovery: "Recovery flood",
  assistant_completion: "Assistant completion integrity shortfall",
}

/**
 * Compact, model-safe explanation of a score, or undefined for high scores.
 * Generic only — never derived from model reasoning or conversation text.
 */
export function explainScore(score: number): string | undefined {
  const s = Math.round(score)
  if (s >= HIGH_SCORE_CUTOFF) return undefined
  if (s >= 40) return "Reduced FlowDeck integrity"
  if (s >= 20) return "Low FlowDeck integrity"
  return "Critical FlowDeck integrity drop"
}

/**
 * "FlowDeck NN%" — the exact scoring suffix rendered by the TUI.
 */
export function formatScoreLine(score: number): string {
  return "FlowDeck " + Math.round(score) + "%"
}

/**
 * Build a TUI-visible score annotation.
 *
 * - title = `label + " — FlowDeck NN%"`
 * - metadata = { fd: { selfAudit: { score, actionClass, sessionID } } }
 * - When score < 60 AND an explanation is supplied, a short (<=140 chars),
 *   generic explanation is added to fd.selfAudit.explanation. The caller's raw
 *   explanation is used only as a gate — the stored value is a fixed generic
 *   string so no hidden reasoning or conversation content can ever appear.
 *
 * The annotation never includes the model's own text.
 */
export function buildScoreAnnotation(input: BuildScoreAnnotationInput): ScoreAnnotation {
  const score = typeof input.score === "number" && Number.isFinite(input.score)
    ? Math.min(100, Math.max(0, input.score))
    : 0

  const selfAudit: Record<string, unknown> = {
    score,
    actionClass: input.actionClass,
    sessionID: input.sessionID,
  }

  const hasExplanation = typeof input.explanation === "string" && input.explanation.trim().length > 0
  if (score < HIGH_SCORE_CUTOFF && hasExplanation) {
    // Always short and generic, regardless of what the caller passed in.
    selfAudit.explanation = GENERIC_REASONS[input.actionClass]
      ?? explainScore(score)
      ?? "Reduced FlowDeck integrity"
  }

  return {
    title: input.label + " — " + formatScoreLine(score),
    metadata: { fd: { selfAudit } },
  }
}
