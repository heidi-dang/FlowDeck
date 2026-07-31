/** Domain port for verification and evidence persistence. */
export interface VerificationResultRecord {
  id: string; runId: string; assignmentId: string | null
  runAcceptanceCriterionId: string | null; verificationRuleId: string | null
  verificationType: string; status: string; targetSha: string
  command: string | null; exitCode: number | null
  outputSummary: string | null; errorOutput: string | null
  isStale: boolean; startedAt: string; completedAt: string | null; durationMs: number | null
}

export interface EvidenceRecord {
  id: string; runId: string; evidenceType: string; title: string; description: string | null
  source: string; sourceId: string | null; contentHash: string
  filePath: string | null; format: string; size: number | null; sha: string; createdAt: string
}

export interface EvidenceLifecycleRecord {
  evidenceId: string; status: string; supersededAt: string | null; expiresAt: string | null
}

export interface CriterionEvidenceRecord {
  runAcceptanceCriterionId: string; evidenceId: string; relationship: string; linkedAt: string
}

export interface VerificationRepository {
  insertResult(record: VerificationResultRecord): Promise<VerificationResultRecord>
  getResultsByRun(runId: string): Promise<VerificationResultRecord[]>
  getResultsByCriterion(criterionId: string, runId: string): Promise<VerificationResultRecord[]>
  getCurrentPassingResult(ruleId: string, runId: string, sha: string): Promise<VerificationResultRecord | null>
}

export interface EvidenceRepository {
  insertEvidence(record: EvidenceRecord): Promise<EvidenceRecord>
  getEvidence(id: string): Promise<EvidenceRecord | null>
  getEvidenceByRun(runId: string): Promise<EvidenceRecord[]>
  upsertLifecycle(record: EvidenceLifecycleRecord): Promise<EvidenceLifecycleRecord>
  linkCriterionEvidence(record: CriterionEvidenceRecord): Promise<void>
  getEvidenceForCriterion(criterionId: string, runId: string, sha: string): Promise<EvidenceRecord | null>
}
