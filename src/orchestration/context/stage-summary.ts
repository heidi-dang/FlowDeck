/**
 * Stage summaries for compacting stage transcripts.
 * @module orchestration/context/stage-summary
 */

import type { RunStage } from "./context-manifest";

export type DecisionOutcome = "accepted" | "rejected" | "deferred";

export interface Decision {
  readonly id: string;
  readonly description: string;
  readonly outcome: DecisionOutcome;
  readonly rationale?: string;
}

export interface FileRef {
  readonly path: string;
  readonly changeType: "created" | "modified" | "deleted";
}

export interface EvidenceRef {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
}

export type StageOutcome = "success" | "failure" | "partial";

export interface StageSummary {
  readonly stage: RunStage;
  readonly outcome: StageOutcome;
  readonly decisions: readonly Decision[];
  readonly filesTouched: readonly FileRef[];
  readonly evidence: readonly EvidenceRef[];
  readonly unresolvedRisks: readonly string[];
  readonly nextStageInputs: readonly string[];
  readonly summaryText: string;
  readonly tokenCost: number;
}

export interface StageSummaryOptions {
  readonly stage: RunStage;
  readonly outcome: StageOutcome;
  readonly decisions?: readonly Decision[];
  readonly filesTouched?: readonly FileRef[];
  readonly evidence?: readonly EvidenceRef[];
  readonly unresolvedRisks?: readonly string[];
  readonly nextStageInputs?: readonly string[];
  readonly summaryText: string;
  readonly tokenCost: number;
}

/**
 * Creates a stage summary from stage execution data.
 */
export function createStageSummary(options: StageSummaryOptions): StageSummary {
  return Object.freeze({
    stage: options.stage,
    outcome: options.outcome,
    decisions: Object.freeze(options.decisions ?? []),
    filesTouched: Object.freeze(options.filesTouched ?? []),
    evidence: Object.freeze(options.evidence ?? []),
    unresolvedRisks: Object.freeze(options.unresolvedRisks ?? []),
    nextStageInputs: Object.freeze(options.nextStageInputs ?? []),
    summaryText: options.summaryText,
    tokenCost: options.tokenCost,
  });
}

/**
 * Returns true if the stage outcome indicates failure.
 */
export function isStageFailure(summary: StageSummary): boolean {
  return summary.outcome === "failure";
}

/**
 * Returns true if the stage has unresolved risks.
 */
export function hasUnresolvedRisks(summary: StageSummary): boolean {
  return summary.unresolvedRisks.length > 0;
}
