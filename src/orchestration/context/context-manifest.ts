/**
 * Context manifest for tracking selected context items in a task run.
 * @module orchestration/context/context-manifest
 */

import type { State } from "../runtime/states.ts";

/** Stage/phase of the runtime. Maps to State but allows for richer staging. */
export type RunStage = State | "initialization" | "finalization";

export interface RequirementRef {
  id: string;
  description: string;
  critical: boolean;
}

export interface CriterionRef {
  id: string;
  description: string;
  critical: boolean;
}

export interface ContextItemRef {
  type: "file" | "symbol" | "test" | "doc" | "diff";
  path?: string;
  symbol?: string;
  reason: string;
  priority: "mandatory" | "high" | "optional";
  tokenEstimate: number;
}

export interface ContextManifest {
  runId: string;
  stage: RunStage;
  objective: string;
  requirements: RequirementRef[];
  acceptanceCriteria: CriterionRef[];
  repositorySha: string;
  selectedItems: ContextItemRef[];
  omittedItemCount: number;
  tokenBudget: number;
  tokenUsage: number;
}

export function createEmptyManifest(runId: string, repositorySha: string, tokenBudget: number): ContextManifest {
  return {
    runId,
    stage: "created",
    objective: "",
    requirements: [],
    acceptanceCriteria: [],
    repositorySha,
    selectedItems: [],
    omittedItemCount: 0,
    tokenBudget,
    tokenUsage: 0,
  };
}
