/**
 * Typed errors and reason codes for canonical evidence import validation.
 *
 * Every rejection path in the canonical evidence adapter throws one of these
 * typed errors, each carrying a stable machine-readable reason code so
 * callers can react deterministically (and tests can assert the exact reason).
 */

export type CanonicalImportReasonCode =
  | "CANONICAL_RUN_NOT_FOUND"
  | "CANONICAL_RUN_ID_MISMATCH"
  | "RUN_CURRENT_SHA_MISSING"
  | "RUN_SHA_MISMATCH"
  | "REPORT_SHA_MISMATCH"
  | "REPORT_SOURCE_REVISION_MISSING"
  | "RUN_NOT_ELIGIBLE"
  | "CRITERION_CONTRACT_MISMATCH"
  | "CRITERION_RUN_MISMATCH"
  | "REPORT_SUPERSEDED"
  | "IMPORT_IN_PROGRESS"
  | "IMPORT_CONFLICT"
  | "IMPORT_FAILED"
  | "IMPORT_IDEMPOTENCY_MISSING_RESULT";

export class CanonicalImportError extends Error {
  public readonly code: CanonicalImportReasonCode;
  public readonly detail?: string;

  constructor(code: CanonicalImportReasonCode, message: string, detail?: string) {
    super(message);
    this.name = "CanonicalImportError";
    this.code = code;
    this.detail = detail;
  }
}

export class CanonicalRunNotFoundError extends CanonicalImportError {
  constructor(runId: string) {
    super("CANONICAL_RUN_NOT_FOUND", `Canonical run not found: ${runId}`);
  }
}

export class CanonicalRunIdMismatchError extends CanonicalImportError {
  constructor(expected: string, actual: string) {
    super("CANONICAL_RUN_ID_MISMATCH", `Canonical run id mismatch: requested ${expected}, resolved ${actual}`);
  }
}

export class RunCurrentShaMissingError extends CanonicalImportError {
  constructor(runId: string) {
    super("RUN_CURRENT_SHA_MISSING", `Canonical run ${runId} has no current SHA`);
  }
}

export class RunShaMismatchError extends CanonicalImportError {
  constructor(runId: string, expected: string, actual: string) {
    super("RUN_SHA_MISMATCH", `Canonical run ${runId} current SHA ${actual} != requested ${expected}`);
  }
}

export class ReportShaMismatchError extends CanonicalImportError {
  constructor(reportRevision: string, expected: string) {
    super("REPORT_SHA_MISMATCH", `Report sourceRevision ${reportRevision} != requested SHA ${expected}`);
  }
}

export class ReportSourceRevisionMissingError extends CanonicalImportError {
  constructor() {
    super("REPORT_SOURCE_REVISION_MISSING", "Report has no sourceRevision and no SHA was provided");
  }
}

export class RunNotEligibleError extends CanonicalImportError {
  constructor(runId: string, state: string) {
    super("RUN_NOT_ELIGIBLE", `Canonical run ${runId} is in ineligible state "${state}"`);
  }
}

export class CriterionContractMismatchError extends CanonicalImportError {
  constructor(criterionId: string, expectedContractId: string, actualContractId: string) {
    super(
      "CRITERION_CONTRACT_MISMATCH",
      `Criterion ${criterionId} belongs to contract ${actualContractId}, expected ${expectedContractId}`,
    );
  }
}

export class CriterionRunMismatchError extends CanonicalImportError {
  constructor(criterionId: string, runId: string) {
    super("CRITERION_RUN_MISMATCH", `Criterion ${criterionId} is not bound to run ${runId}`);
  }
}

export class ReportSupersededError extends CanonicalImportError {
  constructor(runId: string, sha: string) {
    super("REPORT_SUPERSEDED", `A newer report has already been imported for run ${runId} at ${sha}`);
  }
}

export class ImportInProgressError extends CanonicalImportError {
  constructor(importKey: string) {
    super("IMPORT_IN_PROGRESS", `Import already in progress for key ${importKey}`);
  }
}

export class ImportConflictError extends CanonicalImportError {
  constructor(importKey: string) {
    super("IMPORT_CONFLICT", `Idempotency key ${importKey} was used with different inputs`);
  }
}

export class ImportFailedError extends CanonicalImportError {
  constructor(importKey: string, detail: string) {
    super("IMPORT_FAILED", `Import for key ${importKey} failed: ${detail}`);
  }
}

export class ImportIdempotencyMissingResultError extends CanonicalImportError {
  constructor(importKey: string) {
    super("IMPORT_IDEMPOTENCY_MISSING_RESULT", `Completed idempotency record ${importKey} has no stored result`);
  }
}
