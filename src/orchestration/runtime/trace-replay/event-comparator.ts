/**
 * Event comparison utilities for expected vs actual validation.
 * @module orchestration/runtime/trace-replay
 */

import { TraceEvent } from "./trace-schema.js";

export interface ComparisonResult {
  match: boolean;
  differences: EventDifference[];
}

export interface EventDifference {
  originalId: string;
  replayedId: string;
  field: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

/**
 * Validates that events maintain chronological ordering during replay.
 * Both original and replayed traces must have non-decreasing timestamps.
 */
export function validateEventOrder(original: TraceEvent[], replayed: TraceEvent[]): boolean {
  const originalTimestamps = original.map((e) => ({ id: e.id, ts: e.timestamp }));
  const replayedTimestamps = replayed.map((e) => ({
    id: e.id.replace("-replay", ""),
    ts: e.timestamp,
  }));

  // Check original trace ordering
  for (let i = 1; i < originalTimestamps.length; i++) {
    if (originalTimestamps[i].ts < originalTimestamps[i - 1].ts) {
      return false;
    }
  }

  // Check replayed trace ordering
  for (let i = 1; i < replayedTimestamps.length; i++) {
    if (replayedTimestamps[i].ts < replayedTimestamps[i - 1].ts) {
      return false;
    }
  }

  return true;
}

/**
 * Validates that replay produces the same event sequence as original.
 * Checks event count and type sequence match.
 */
export function validateReproducibility(original: TraceEvent[], replayed: TraceEvent[]): boolean {
  if (original.length !== replayed.length) {
    return false;
  }

  for (let i = 0; i < original.length; i++) {
    const origType = original[i].type;
    const replayType = replayed[i].type;
    if (origType !== replayType) {
      return false;
    }
  }

  return true;
}

/**
 * Compares two traces and reports exact mismatches.
 */
export function compareTraces(
  original: TraceEvent[],
  replayed: TraceEvent[]
): ComparisonResult {
  const differences: EventDifference[] = [];

  if (original.length !== replayed.length) {
    differences.push({
      originalId: "n/a",
      replayedId: "n/a",
      field: "length",
      expected: original.length,
      actual: replayed.length,
      message: `Event count mismatch: expected ${original.length}, got ${replayed.length}`,
    });
    return { match: false, differences };
  }

  for (let i = 0; i < original.length; i++) {
    const orig = original[i];
    const replay = replayed[i];

    // Compare type
    if (orig.type !== replay.type) {
      differences.push({
        originalId: orig.id,
        replayedId: replay.id,
        field: "type",
        expected: orig.type,
        actual: replay.type,
        message: `Event ${i} type mismatch: expected "${orig.type}", got "${replay.type}"`,
      });
    }

    // Compare timestamp
    if (orig.timestamp !== replay.timestamp) {
      differences.push({
        originalId: orig.id,
        replayedId: replay.id,
        field: "timestamp",
        expected: orig.timestamp,
        actual: replay.timestamp,
        message: `Event ${i} timestamp mismatch: expected ${orig.timestamp}, got ${replay.timestamp}`,
      });
    }

    // Compare error if present
    if (orig.error !== replay.error) {
      differences.push({
        originalId: orig.id,
        replayedId: replay.id,
        field: "error",
        expected: orig.error,
        actual: replay.error,
        message: `Event ${i} error mismatch: expected "${orig.error}", got "${replay.error}"`,
      });
    }
  }

  return {
    match: differences.length === 0,
    differences,
  };
}

/**
 * Gets diagnostic information for a mismatch.
 */
export function getMismatchDiagnostics(
  original: TraceEvent[],
  replayed: TraceEvent[]
): string[] {
  const diagnostics: string[] = [];
  const comparison = compareTraces(original, replayed);

  if (comparison.match) {
    return ["Traces match exactly"];
  }

  for (const diff of comparison.differences) {
    diagnostics.push(diff.message);
  }

  return diagnostics;
}
