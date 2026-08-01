/**
 * Context invalidation based on repository state changes.
 * @module orchestration/context/context-invalidation
 */

import { hashContent } from "./content-hasher";

export interface RepositoryState {
  readonly sha: string;
  readonly branch: string;
  readonly isDirty: boolean;
  readonly modifiedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
}

export interface InvalidationReason {
  readonly reason: "sha-change" | "dirty-tree" | "file-modified" | "file-deleted";
  readonly details: string;
}

export interface InvalidationResult {
  readonly isInvalid: boolean;
  readonly reasons: readonly InvalidationReason[];
  readonly fingerprint: string;
}

const EMPTY_STATE: RepositoryState = {
  sha: "",
  branch: "",
  isDirty: false,
  modifiedFiles: [],
  stagedFiles: [],
};

/**
 * Detects whether context should be invalidated based on repository state.
 */
export function detectInvalidation(
  previousState: RepositoryState | null,
  currentState: RepositoryState,
): InvalidationResult {
  const reasons: InvalidationReason[] = [];

  if (!previousState) {
    const fingerprint = computeStateFingerprint(currentState);
    return {
      isInvalid: false,
      reasons: [],
      fingerprint,
    };
  }

  if (previousState.sha !== currentState.sha) {
    reasons.push({
      reason: "sha-change",
      details: `SHA changed from ${previousState.sha} to ${currentState.sha}`,
    });
  }

  if (currentState.isDirty && !previousState.isDirty) {
    reasons.push({
      reason: "dirty-tree",
      details: "Working tree became dirty",
    });
  }

  const addedModified = currentState.modifiedFiles.filter(
    (f) => !previousState.modifiedFiles.includes(f),
  );
  if (addedModified.length > 0) {
    reasons.push({
      reason: "file-modified",
      details: `Modified files: ${addedModified.join(", ")}`,
    });
  }

  const deletedFiles = previousState.modifiedFiles.filter(
    (f) => !currentState.modifiedFiles.includes(f) && !currentState.modifiedFiles.includes(f),
  );
  if (deletedFiles.length > 0) {
    reasons.push({
      reason: "file-deleted",
      details: `Potentially deleted: ${deletedFiles.join(", ")}`,
    });
  }

  const fingerprint = computeStateFingerprint(currentState);
  return {
    isInvalid: reasons.length > 0,
    reasons: Object.freeze(reasons),
    fingerprint,
  };
}

/**
 * Computes a fingerprint for the repository state.
 */
export function computeStateFingerprint(state: RepositoryState): string {
  const components = [
    state.sha,
    state.branch,
    state.isDirty ? "dirty" : "clean",
    state.modifiedFiles.slice().sort().join(","),
    state.stagedFiles.slice().sort().join(","),
  ];
  return hashContent(components.join("|"));
}

/**
 * Creates an empty repository state for comparison.
 */
export function createEmptyRepositoryState(): RepositoryState {
  return { ...EMPTY_STATE };
}
