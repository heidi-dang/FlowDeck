/**
 * RoutingRevisionService — Authoritative versioned routing decision and goal revision manager.
 *
 * Responsibilities:
 * - Retrieve latest authoritative RoutingDecision for a Run from SQLite
 * - Deterministically compose effective updated goal without runaway nesting
 * - Reclassify updated goal and determine whether class remains compatible in same Run or requires superseding Run
 * - Append new RoutingDecision version with updated goal, hash, and metadata
 */

import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
} from "./fast-router-adapter";
import {
  classifyTask,
  type RouterDecision,
  type ExecutionClass,
} from "../../services/heidi-fast-router";
import type { RoutingDecision } from "./contracts/task-intelligence";
import type { SqliteRoutingDecisionRepository } from "./sqlite-store";

export interface ApplyGoalModificationInput {
  runId: string;
  sessionID: string;
  modificationText: string;
  newMessageHash: string;
  directory?: string;
  sourceSha?: string;
}

export type GoalModificationResult =
  | {
      outcome: "modified";
      decision: RoutingDecision;
      effectiveGoal: string;
      decisionVersion: number;
    }
  | {
      outcome: "reclassify_required";
      effectiveGoal: string;
      newDecision: RouterDecision;
    };

/** Deterministic execution class compatibility check for same-Run escalation */
export function isExecutionClassCompatible(oldClass: ExecutionClass, newClass: ExecutionClass): boolean {
  if (oldClass === newClass) return true;
  // Specialist and Parallel Specialists share the "delegated" RunStrategy and execution lifecycle
  if (
    (oldClass === "SPECIALIST" && newClass === "PARALLEL_SPECIALISTS") ||
    (oldClass === "PARALLEL_SPECIALISTS" && newClass === "SPECIALIST")
  ) {
    return true;
  }
  return false;
}

/** Deterministically compose effective updated goal without nesting (Modified: (Modified: ...)) */
export function composeUpdatedGoal(prevGoal: string, modificationText: string): string {
  const trimmedMod = modificationText.trim();
  if (!prevGoal || !prevGoal.trim()) {
    return trimmedMod;
  }
  const trimmedPrev = prevGoal.trim();
  const match = trimmedPrev.match(/^(.*?)\s*\(Modified:\s*(.*)\)$/);
  if (match) {
    const base = match[1].trim();
    const priorMods = match[2].trim();
    return `${base} (Modified: ${priorMods}; ${trimmedMod})`;
  }
  return `${trimmedPrev} (Modified: ${trimmedMod})`;
}

export class RoutingRevisionService {
  constructor(private readonly routingRepo: SqliteRoutingDecisionRepository) {}

  applyModification(input: ApplyGoalModificationInput): GoalModificationResult {
    const latestDecision = this.routingRepo.getLatestDecisionForRun(input.runId);
    const reconstructed = latestDecision ? reconstructRouterDecision(latestDecision) : null;
    const prevGoal = reconstructed?.goal ?? latestDecision?.rationale[0] ?? "";
    const effectiveGoal = composeUpdatedGoal(prevGoal, input.modificationText);

    // Reclassify updated goal
    const newDecision = classifyTask(effectiveGoal, { hasExplicitDomainSignal: false });
    const oldClass = reconstructed?.decision.executionClass ?? "STANDARD";

    if (!isExecutionClassCompatible(oldClass, newDecision.executionClass)) {
      return {
        outcome: "reclassify_required",
        effectiveGoal,
        newDecision,
      };
    }

    const mergedDecision: RouterDecision = {
      ...newDecision,
      forcedByExplicitSignal: newDecision.forcedByExplicitSignal || (reconstructed?.decision.forcedByExplicitSignal ?? false),
      specialists: newDecision.specialists ?? reconstructed?.decision.specialists,
      suggestedAgents: newDecision.suggestedAgents ?? reconstructed?.decision.suggestedAgents,
    };

    const canonical = buildCanonicalRoutingDecision({
      runId: input.runId,
      decision: mergedDecision,
      goal: effectiveGoal,
      lastUserMessageHash: input.newMessageHash,
      directory: input.directory,
      sourceSha: input.sourceSha,
    });

    const saved = this.routingRepo.saveDecision(canonical);

    return {
      outcome: "modified",
      decision: saved,
      effectiveGoal,
      decisionVersion: saved.decisionVersion,
    };
  }
}
