/**
 * FlowDeck score-leak guard.
 *
 * Guarantees that score / TUI metadata (the `fd.selfAudit` shape produced by
 * visible-score-surface) stays SEPARATE from the provider-visible (model-visible)
 * transcript. Any text line that is a FlowDeck score annotation, and any part
 * metadata carrying `fd.selfAudit`, is stripped before a history is handed to
 * the provider.
 *
 * All functions are pure: inputs are never mutated, message count never
 * increases, and stripping is idempotent.
 */

/** Matches a FlowDeck score line anywhere in text, e.g. "Shell x — FlowDeck 96%". */
const SCORE_TEXT_RE = /FlowDeck \d+%/

export interface ScoreLeakMessage {
  info: unknown
  parts: unknown[]
}

/**
 * True when the value is shaped like `{ fd: { selfAudit: { ... } } }` — the
 * FlowDeck score-metadata surface that must never reach the provider.
 */
export function isScoreMetadata(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  const fd = obj.fd
  if (fd == null || typeof fd !== "object") return false
  const selfAudit = (fd as Record<string, unknown>).selfAudit
  return selfAudit != null && typeof selfAudit === "object"
}

/**
 * Return a NEW copy of `messages` in which:
 *   - any text part whose text is a FlowDeck score annotation line is removed, and
 *   - any part's metadata shaped like `fd.selfAudit` is removed.
 *
 * Never mutates the input, never increases the message count, and is idempotent.
 */
export function stripScoreAnnotations(messages: ScoreLeakMessage[]): ScoreLeakMessage[] {
  const out: ScoreLeakMessage[] = []
  for (const msg of messages) {
    const parts: unknown[] = Array.isArray(msg.parts) ? msg.parts : []
    const nextParts: unknown[] = []
    for (const part of parts) {
      if (part == null || typeof part !== "object") {
        nextParts.push(part)
        continue
      }
      const p = part as Record<string, unknown>
      // Drop text parts that ARE (or contain) a FlowDeck score annotation line.
      if (typeof p.text === "string" && SCORE_TEXT_RE.test(p.text)) continue
      // Remove score metadata from the part without mutating the input part.
      if (p.metadata !== undefined && isScoreMetadata(p.metadata)) {
        const copy = { ...p }
        delete copy.metadata
        nextParts.push(copy)
      } else {
        nextParts.push(part)
      }
    }
    out.push({ ...msg, parts: nextParts })
  }
  return out
}

/**
 * True iff there is no score leak in the transcript: no part text contains a
 * "FlowDeck NN%" line and no part metadata carries `fd.selfAudit`.
 */
export function assertNoScoreLeak(messages: ScoreLeakMessage[]): boolean {
  for (const msg of messages) {
    const parts: unknown[] = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
      if (part == null || typeof part !== "object") continue
      const p = part as Record<string, unknown>
      if (typeof p.text === "string" && SCORE_TEXT_RE.test(p.text)) return false
      if (p.metadata !== undefined && isScoreMetadata(p.metadata)) return false
    }
  }
  return true
}
