/**
 * Evidence link value object.
 *
 * Links evidence to specific acceptance criteria or verification rules.
 * Multiple evidence items may link to the same criterion. One evidence
 * item may link to multiple criteria.
 */

export interface EvidenceLinkData {
  readonly evidenceId: string
  readonly criterionId?: string
  readonly ruleId?: string
  readonly createdAt: Date
}

export class EvidenceLink {
  public readonly evidenceId: string
  public readonly criterionId?: string
  public readonly ruleId?: string
  public readonly createdAt: Date

  constructor(data: EvidenceLinkData) {
    this.evidenceId = data.evidenceId
    this.criterionId = data.criterionId
    this.ruleId = data.ruleId
    this.createdAt = data.createdAt
  }
}
