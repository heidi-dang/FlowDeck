/**
 * Failure Deduplication & Observation Tracker
 *
 * Maintains observation boundaries per session/task to track first seen, last seen,
 * occurrences, and distinguish old errors from previous generations vs fresh recurrences
 * after source code edits.
 */

import type { BrowserFailureFingerprint } from "./types";

export interface DeduplicationSummary {
  activeFailures: BrowserFailureFingerprint[];
  resolvedFailures: BrowserFailureFingerprint[];
  newFailuresSinceLastGeneration: BrowserFailureFingerprint[];
  totalOccurrences: number;
}

export class FailureDeduplicator {
  private knownFailures = new Map<string, BrowserFailureFingerprint>();
  private resolvedFingerprints = new Set<string>();

  /**
   * Register a fresh batch of observed failures from a navigation/reproduction run.
   */
  public processObservations(
    incoming: BrowserFailureFingerprint[],
    currentNavigationGeneration: number
  ): DeduplicationSummary {
    const newFailuresSinceLastGeneration: BrowserFailureFingerprint[] = [];
    const seenThisPass = new Set<string>();

    for (const failure of incoming) {
      const existing = this.knownFailures.get(failure.fingerprint);
      seenThisPass.add(failure.fingerprint);

      if (existing) {
        existing.occurrences++;
        existing.lastSeenAt = failure.lastSeenAt;
        existing.navigationGeneration = currentNavigationGeneration;

        // If previously resolved but re-appeared, mark re-opened!
        if (this.resolvedFingerprints.has(failure.fingerprint)) {
          this.resolvedFingerprints.delete(failure.fingerprint);
          newFailuresSinceLastGeneration.push(existing);
        }
      } else {
        const entry: BrowserFailureFingerprint = {
          ...failure,
          navigationGeneration: currentNavigationGeneration,
          occurrences: 1,
        };
        this.knownFailures.set(failure.fingerprint, entry);
        newFailuresSinceLastGeneration.push(entry);
      }
    }

    // Check if any previously known active failures were NOT seen in this pass
    for (const [fp, entry] of this.knownFailures.entries()) {
      if (!seenThisPass.has(fp) && entry.navigationGeneration < currentNavigationGeneration) {
        this.resolvedFingerprints.add(fp);
      }
    }

    const activeFailures: BrowserFailureFingerprint[] = [];
    const resolvedFailures: BrowserFailureFingerprint[] = [];

    for (const [fp, entry] of this.knownFailures.entries()) {
      if (this.resolvedFingerprints.has(fp)) {
        resolvedFailures.push(entry);
      } else {
        activeFailures.push(entry);
      }
    }

    const totalOccurrences = Array.from(this.knownFailures.values()).reduce(
      (sum, f) => sum + f.occurrences,
      0
    );

    return {
      activeFailures,
      resolvedFailures,
      newFailuresSinceLastGeneration,
      totalOccurrences,
    };
  }

  /**
   * Check if a specific failure has been resolved in the current observation window.
   */
  public isResolved(fingerprint: string): boolean {
    return this.resolvedFingerprints.has(fingerprint);
  }

  /**
   * Get all active actionable failures.
   */
  public getActiveActionableFailures(): BrowserFailureFingerprint[] {
    return Array.from(this.knownFailures.values()).filter(
      (f) =>
        !this.resolvedFingerprints.has(f.fingerprint) &&
        (f.classification === "actionable" || f.classification === "unknown")
    );
  }

  /**
   * Clear all deduplication state.
   */
  public reset(): void {
    this.knownFailures.clear();
    this.resolvedFingerprints.clear();
  }
}
