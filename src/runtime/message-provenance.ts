/**
 * message-provenance.ts
 *
 * Authoritative registry of internal FlowDeck message prefixes and detection logic.
 *
 * INVARIANT: Internal orchestration messages injected via session.promptAsync
 * must never establish genuine user authority, must never increment
 * userTurnVersion, and must never enter the task classification path.
 *
 * These prefixes are produced exclusively by:
 *   - ContinuationPolicy / getContinuationPrompt()
 *   - dispatchReadySpecialists() in flowdeck-opencode-adapter.ts
 *   - resumeDeferredReplacement() in flowdeck-opencode-adapter.ts
 *
 * Text alone does not grant internal provenance: a real user who types one of
 * these strings will have their message correctly classified by userTurnIntent
 * as CONTINUE/QUERY/ACKNOWLEDGE, which are non-mutating. The critical invariant
 * is that these messages MUST NOT increment userTurnVersion, which is what the
 * fix in onChatMessage enforces.
 */

/**
 * Exact-prefix set for all strings FlowDeck injects via session.promptAsync.
 * These are the only strings that must be rejected from genuine-user-turn processing.
 *
 * Rules for adding to this list:
 *  1. Only add strings that FlowDeck produces via promptAsync / continuation dispatch.
 *  2. Do not add strings that might plausibly be typed by a real user as a task.
 *  3. Keep this list synchronized with getContinuationPrompt() and dispatchReadySpecialists().
 */
export const INTERNAL_FLOWDECK_PREFIXES: readonly string[] = [
  // Specialist dispatch header (dispatchReadySpecialists)
  "[FlowDeck Specialist Dispatch]",
  // Deferred replacement continuation (resumeDeferredReplacement)
  "[Continuation] Resume the deferred user goal",
  // getContinuationPrompt() outputs (continuation-policy.ts)
  "Continue with the next planned work item.",
  "Recovery progress detected. Continue execution with the updated state.",
  "Work completed. Proceed to verify the results.",
  "Execution stall detected with no progress. Change strategy",
  "Child execution failed. Analyze the failure and select an alternate strategy",
  "Assignment failed. Analyze the failure and select an alternate strategy",
  "Transient failure encountered. Retry the action.",
  "Progress confirmed. Continue with the next step.",
  "Continue with the next planned step.",
  // Fallback continuation prompt
  "Previous strategy produced no progress",
] as const;

/**
 * Returns true if the given message text was produced by FlowDeck's internal
 * orchestration system (injected via session.promptAsync) and must NOT be
 * treated as genuine user intent.
 *
 * Detection is prefix-based on the canonical strings FlowDeck itself produces.
 * This is NOT string-matching to suppress a loop: it is provenance classification
 * at the authority boundary, before userTurnVersion is incremented.
 */
export function isInternalFlowDeckMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return INTERNAL_FLOWDECK_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}
