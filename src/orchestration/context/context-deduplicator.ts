/**
 * Context deduplication to reduce redundant context items.
 * @module orchestration/context/context-deduplicator
 */

import type { ContextReference } from "./context-reference";
import { ContextReferenceFactory } from "./context-reference";

export interface ContextItem {
  readonly id: string;
  readonly contentHash: string;
  readonly content: string;
  readonly type: string;
  readonly path?: string;
  readonly range?: { start: number; end: number };
}

export interface DeduplicationResult {
  readonly uniqueItems: ContextItem[];
  readonly duplicateCount: number;
}

/**
 * Removes exact duplicate context items based on content hash.
 */
export function deduplicate(items: ContextItem[]): DeduplicationResult {
  const seen = new Map<string, ContextItem>();
  let duplicateCount = 0;

  for (const item of items) {
    const existing = seen.get(item.contentHash);
    if (existing) {
      duplicateCount++;
    } else {
      seen.set(item.contentHash, item);
    }
  }

  return {
    uniqueItems: Array.from(seen.values()),
    duplicateCount,
  };
}

export interface SuppressionResult {
  readonly kept: ContextItem[];
  readonly suppressed: ContextItem[];
}

/**
 * Suppresses items that have not changed between baseline and current.
 */
export function suppressUnchanged(baseline: ContextItem[], current: ContextItem[]): SuppressionResult {
  const baselineHashes = new Set(baseline.map((b) => b.contentHash));
  const kept: ContextItem[] = [];
  const suppressed: ContextItem[] = [];

  for (const item of current) {
    if (baselineHashes.has(item.contentHash)) {
      suppressed.push(item);
    } else {
      kept.push(item);
    }
  }

  return { kept, suppressed };
}

export interface DuplicationDetection {
  readonly redundantIds: string[];
  readonly coveragePercent: number;
}

/**
 * Detects redundant context between two sets.
 */
export function detectDuplication(contextA: ContextItem[], contextB: ContextItem[]): DuplicationDetection {
  const hashesA = new Set(contextA.map((i) => i.contentHash));
  const redundantIds: string[] = [];

  for (const item of contextB) {
    if (hashesA.has(item.contentHash)) {
      redundantIds.push(item.id);
    }
  }

  const coveragePercent = contextB.length > 0 ? (redundantIds.length / contextB.length) * 100 : 0;

  return { redundantIds, coveragePercent };
}
