/**
 * Evidence entity.
 *
 * Evidence captures proof that a verification rule or acceptance criterion
 * has been satisfied. Evidence content is immutable once created.
 * Archiving preserves content but marks it as historical (no longer current).
 */

export type EvidenceStatus = "current" | "archived"

export interface EvidenceData {
  readonly id: string
  readonly content: string
  readonly contentType: string
  readonly sha: string
  readonly runId: string
  readonly criterionIds: readonly string[]
  readonly status: EvidenceStatus
  readonly createdAt: Date
  readonly archivedAt?: Date
}

export class Evidence {
  public readonly id: string
  public readonly content: string
  public readonly contentType: string
  public readonly sha: string
  public readonly runId: string
  public readonly criterionIds: readonly string[]
  public readonly status: EvidenceStatus
  public readonly createdAt: Date
  public readonly archivedAt?: Date

  constructor(data: EvidenceData) {
    this.id = data.id
    this.content = data.content
    this.contentType = data.contentType
    this.sha = data.sha
    this.runId = data.runId
    this.criterionIds = Object.freeze([...data.criterionIds])
    this.status = data.status
    this.createdAt = data.createdAt
    this.archivedAt = data.archivedAt
  }

  get isArchived(): boolean {
    return this.status === "archived"
  }

  /**
   * Archives evidence. Content is preserved but status changes to archived.
   * Archived evidence is still traceable and its content remains readable.
   */
  archive(now: Date): Evidence {
    return new Evidence({
      ...this,
      status: "archived",
      archivedAt: now,
    })
  }

  /**
   * Returns true if this evidence targets the given SHA.
   */
  matchesSha(sha: string): boolean {
    return this.sha === sha
  }

  /**
   * Returns true if this evidence belongs to the given run.
   */
  belongsToRun(runId: string): boolean {
    return this.runId === runId
  }
}
