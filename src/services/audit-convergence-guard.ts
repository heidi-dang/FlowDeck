import { createHash } from "node:crypto";

/**
 * OpenCode 1.18.20 provides no native loop detection, tool-call fingerprinting,
 * or no-progress cycle detection. This narrowly scoped FlowDeck guard enforces
 * convergence on Heidi's routing/decision layer.
 */
export interface ConvergenceState {
  currentWorkItem: string;
  completedWorkItems: string[];
  lastEffectiveActionFingerprint: string;
  lastEffectiveResultHash: string;
  consecutiveNoProgressActions: number;
  duplicateActionSuppressions: number;
  strategyChanges: number;
  terminalStatus: "running" | "blocked" | "complete";
}

const states = new Map<string, ConvergenceState>();

function normalizeArgs(args: any): string {
  if (!args) return "";
  if (typeof args !== "object") return String(args);
  const keys = Object.keys(args).sort();
  const pairs = keys.map(k => {
    let v = args[k];
    if (typeof v === "string") {
      v = v.trim().replace(/\s+/g, " ");
    }
    return `${k}:${v}`;
  });
  return pairs.join("|");
}

export function checkConvergenceBefore(sessionID: string, tool: string, args: any): void {
  if (!states.has(sessionID)) {
    states.set(sessionID, {
      currentWorkItem: "",
      completedWorkItems: [],
      lastEffectiveActionFingerprint: "",
      lastEffectiveResultHash: "",
      consecutiveNoProgressActions: 0,
      duplicateActionSuppressions: 0,
      strategyChanges: 0,
      terminalStatus: "running"
    });
  }
  const state = states.get(sessionID)!;
  const fp = createHash("sha256").update(tool + "|" + normalizeArgs(args)).digest("hex");

  if (fp === state.lastEffectiveActionFingerprint) {
    state.consecutiveNoProgressActions++;
    if (state.consecutiveNoProgressActions >= 3) {
      state.duplicateActionSuppressions++;
      throw new Error(
        "[CONVERGENCE BUDGET EXHAUSTED] You have repeated the exact same successful investigation/tool action multiple times without producing new evidence or converging. " +
        "You MUST advance to the next planned audit/task item, change investigation strategy, report that evidence is exhausted, or ask for clarification.\n" +
        "Metadata:\n" + JSON.stringify(state, null, 2)
      );
    }
  } else {
    state.strategyChanges++;
    state.lastEffectiveActionFingerprint = fp;
    state.consecutiveNoProgressActions = 0;
  }
}

export function checkConvergenceAfter(sessionID: string, tool: string, args: any, result: any): void {
  const state = states.get(sessionID);
  if (!state) return;
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  const resultHash = createHash("sha256").update(resultStr || "").digest("hex");
  state.lastEffectiveResultHash = resultHash;
}
