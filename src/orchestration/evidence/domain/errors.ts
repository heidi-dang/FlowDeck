/**
 * Domain errors for the evidence sub-domain.
 */

export class EvidenceDomainError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "EvidenceDomainError"
    this.code = code
  }
}

export class EvidenceNotFoundError extends EvidenceDomainError {
  constructor(evidenceId: string) {
    super("EVIDENCE_NOT_FOUND", `Evidence not found: ${evidenceId}`)
  }
}

export class ImmutableEvidenceError extends EvidenceDomainError {
  constructor(reason: string) {
    super("IMMUTABLE_EVIDENCE", `Cannot modify evidence: ${reason}`)
  }
}

export class EvidenceShaMismatchError extends EvidenceDomainError {
  constructor(expected: string, actual: string) {
    super("EVIDENCE_SHA_MISMATCH", `Evidence SHA mismatch: expected ${expected}, got ${actual}`)
  }
}

export class EvidenceCrossRunError extends EvidenceDomainError {
  constructor(reason: string) {
    super("EVIDENCE_CROSS_RUN", `Evidence cross-run reference not allowed: ${reason}`)
  }
}

export class EvidenceArchiveError extends EvidenceDomainError {
  constructor(reason: string) {
    super("EVIDENCE_ARCHIVE_ERROR", `Evidence archive error: ${reason}`)
  }
}
