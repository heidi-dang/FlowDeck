/**
 * UserTurnIntent — Deterministic FlowDeck-native user-turn intent classifier.
 *
 * Distinguishes user intent on active/incoming turns:
 * - REPLAY: Exact duplicate prompt delivery
 * - REPLACE: Goal abandonment in favor of a new task (takes precedence over generic cancellation)
 * - CANCEL: Explicit cancellation of current work
 * - CONTINUE: Explicit continuation of in-flight work
 * - QUERY: Status inquiry or inspection question without goal mutation
 * - MODIFY: Requirement refinement or goal update for current active task
 * - ACKNOWLEDGE: Conversational non-mutating acknowledgement (ok, thanks, got it)
 */

export type UserTurnIntent =
  | "REPLAY"
  | "CONTINUE"
  | "MODIFY"
  | "REPLACE"
  | "CANCEL"
  | "QUERY"
  | "ACKNOWLEDGE";

export interface UserTurnIntentInput {
  currentGoal?: string;
  newMessage: string;
  activeRunStatus?: string;
  messageHash?: string;
  lastMessageHash?: string;
}

export interface UserTurnIntentResult {
  intent: UserTurnIntent;
  reasonCode: string;
  confidence: number;
}

const REPLACE_PATTERNS = [
  /^new task\b/i,
  /^stop (?:this|that) and\b/i,
  /^cancel (?:this|that) and\b/i,
  /^abort (?:this|that) and\b/i,
  /^forget (?:this|that),?\s+/i,
  /^forget that\b/i,
  /^instead of (?:this|that)\b/i,
  /^instead,\s*/i,
  /^switch to\b/i,
  /^scrap that\b/i,
  /^scratch that\b/i,
  /^start over with\b/i,
  /^ignore (?:this|that) and\b/i,
  /^do something else\b/i,
  /^nevermind,?\s+(?:do|let's|can you)\b/i,
];

const CANCEL_PATTERNS = [
  /^cancel this task\b/i,
  /^stop this task\b/i,
  /^abort this task\b/i,
  /^forget this task\b/i,
  /^stop execution\b/i,
  /^terminate task\b/i,
  /^kill task\b/i,
  /^cancel\b/i,
  /^stop\b/i,
  /^abort\b/i,
];

const CONTINUE_PATTERNS = [
  /^continue\b/i,
  /^keep going\b/i,
  /^proceed\b/i,
  /^resume\b/i,
  /^next step\b/i,
  /^go ahead\b/i,
  /^carry on\b/i,
  /^please continue\b/i,
  /^next\b/i,
  /^ok continue\b/i,
  /^yes continue\b/i,
];

const QUERY_PATTERNS = [
  /^status\b/i,
  /^what have you done\b/i,
  /^what is left\b/i,
  /^where are we\b/i,
  /^progress\b/i,
  /^how is it going\b/i,
  /^what's next\b/i,
  /^what are you working on\b/i,
  /^current status\b/i,
  /^show status\b/i,
  /^summary of progress\b/i,
];

const MODIFY_PATTERNS = [
  /^change\b/i,
  /^instead use\b/i,
  /^also add\b/i,
  /^remove requirement\b/i,
  /^update the current task to\b/i,
  /^please also\b/i,
  /^actually also\b/i,
  /^modify the\b/i,
  /^let's also\b/i,
  /^add support for\b/i,
  /^also include\b/i,
  /^and also\b/i,
  /\balso add\b/i,
  /\binstead of\b/i,
  /\bchange .* to\b/i,
  /\bupdate .* to\b/i,
];

const ACKNOWLEDGE_PATTERNS = [
  /^(?:thanks|thank you|thx|okay|ok|sounds good|got it|great|yes|understood|cool|perfect|k|sure|alright|all right|noted|acknowledged|nice)[.!]?$/i,
];

export function classifyUserTurnIntent(input: UserTurnIntentInput): UserTurnIntentResult {
  // 1. REPLAY check (exact message hash match)
  if (input.messageHash && input.lastMessageHash && input.messageHash === input.lastMessageHash) {
    return {
      intent: "REPLAY",
      reasonCode: "EXACT_HASH_MATCH",
      confidence: 1.0,
    };
  }

  const trimmed = input.newMessage.trim();

  // 2. REPLACE check (specific replacement signals win over generic cancel/stop)
  for (const pattern of REPLACE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "REPLACE",
        reasonCode: "EXPLICIT_REPLACE_SIGNAL",
        confidence: 0.95,
      };
    }
  }

  // 3. CANCEL check
  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "CANCEL",
        reasonCode: "EXPLICIT_CANCEL_SIGNAL",
        confidence: 0.95,
      };
    }
  }

  // 4. CONTINUE check
  for (const pattern of CONTINUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "CONTINUE",
        reasonCode: "EXPLICIT_CONTINUE_SIGNAL",
        confidence: 0.95,
      };
    }
  }

  // 5. QUERY check
  for (const pattern of QUERY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "QUERY",
        reasonCode: "STATUS_QUERY_SIGNAL",
        confidence: 0.9,
      };
    }
  }

  // 6. MODIFY check
  for (const pattern of MODIFY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "MODIFY",
        reasonCode: "TASK_MODIFICATION_SIGNAL",
        confidence: 0.85,
      };
    }
  }

  // 7. ACKNOWLEDGE check
  for (const pattern of ACKNOWLEDGE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        intent: "ACKNOWLEDGE",
        reasonCode: "CONVERSATIONAL_ACKNOWLEDGEMENT",
        confidence: 0.95,
      };
    }
  }

  // 8. Question fallback heuristics for active runs
  if (trimmed.endsWith("?") || /^(why|how|what|where|who|is|are|can|could|would|should|which)\b/i.test(trimmed)) {
    return {
      intent: "QUERY",
      reasonCode: "AMBIGUOUS_QUERY_FALLBACK",
      confidence: 0.6,
    };
  }

  // 9. Conservative ambiguous fallback (non-mutating CONTINUE without rewriting durable task goal)
  return {
    intent: "CONTINUE",
    reasonCode: "CONSERVATIVE_CONTINUE_FALLBACK",
    confidence: 0.5,
  };
}
