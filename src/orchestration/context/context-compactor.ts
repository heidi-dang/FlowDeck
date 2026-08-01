/**
 * Context compactor for condensing stage transcripts.
 * @module orchestration/context/context-compactor
 */

import type { StageSummary, StageSummaryOptions } from "./stage-summary";
import { createStageSummary } from "./stage-summary";
import type { ContextItem } from "./context-deduplicator";

export interface CompactorConfig {
  readonly maxTranscriptTokens: number;
  readonly preserveEvidence: boolean;
}

const DEFAULT_CONFIG: CompactorConfig = {
  maxTranscriptTokens: 4000,
  preserveEvidence: true,
};

export interface CompactionResult {
  readonly summary: StageSummary;
  readonly originalTokenCount: number;
  readonly compactedTokenCount: number;
  readonly compressionRatio: number;
  readonly preservedArtifacts: readonly string[];
}

export interface TranscriptSegment {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly tokenCount: number;
}

/**
 * Compacts a stage transcript into a summary, preserving references to artifacts.
 */
export function compactTranscript(
  stage: StageSummary,
  transcriptSegments: TranscriptSegment[],
  config: CompactorConfig = DEFAULT_CONFIG,
): CompactionResult {
  const originalTokenCount = transcriptSegments.reduce((sum, s) => sum + s.tokenCount, 0);

  const summaryText = buildSummaryText(stage, transcriptSegments);
  const estimatedTokenCount = estimateTokenCount(summaryText);

  const compressedTokenCount = Math.min(estimatedTokenCount, config.maxTranscriptTokens);
  const compressionRatio =
    originalTokenCount > 0 ? compressedTokenCount / originalTokenCount : 1;

  const preservedArtifacts = extractArtifactReferences(transcriptSegments);

  const compactedSummary = createStageSummary({
    ...stage,
    summaryText,
    tokenCost: compressedTokenCount,
  } as StageSummaryOptions);

  return {
    summary: compactedSummary,
    originalTokenCount,
    compactedTokenCount: compressedTokenCount,
    compressionRatio,
    preservedArtifacts: Object.freeze(preservedArtifacts),
  };
}

function buildSummaryText(stage: StageSummary, segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  lines.push(`## Stage: ${stage.stage}`);
  lines.push(`Outcome: ${stage.outcome}`);

  if (stage.decisions.length > 0) {
    lines.push("\n### Decisions");
    for (const d of stage.decisions) {
      lines.push(`- [${d.outcome}] ${d.description}`);
    }
  }

  if (stage.filesTouched.length > 0) {
    lines.push("\n### Files");
    for (const f of stage.filesTouched) {
      lines.push(`- ${f.changeType}: ${f.path}`);
    }
  }

  if (stage.evidence.length > 0 && stage.evidence.length <= 10) {
    lines.push("\n### Evidence");
    for (const e of stage.evidence) {
      lines.push(`- ${e.type}: ${e.id}${e.path ? ` (${e.path})` : ""}`);
    }
  }

  if (stage.unresolvedRisks.length > 0) {
    lines.push("\n### Unresolved Risks");
    for (const r of stage.unresolvedRisks) {
      lines.push(`- ${r}`);
    }
  }

  const lastAssistantSegment = [...segments].reverse().find((s) => s.role === "assistant");
  if (lastAssistantSegment) {
    lines.push(`\n### Final Response\n${lastAssistantSegment.content.slice(0, 500)}...`);
  }

  return lines.join("\n");
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractArtifactReferences(segments: TranscriptSegment[]): string[] {
  const artifacts: Set<string> = new Set();
  for (const segment of segments) {
    const matches = segment.content.match(/artifact:([a-zA-Z0-9-]+)/g);
    if (matches) {
      for (const match of matches) {
        artifacts.add(match.split(":")[1]);
      }
    }
  }
  return Array.from(artifacts);
}

/**
 * Estimates the token cost for a list of context items.
 */
export function estimateContextTokenCost(items: ContextItem[]): number {
  return items.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0);
}
