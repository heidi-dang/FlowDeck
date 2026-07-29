/** Domain port for contract persistence. Adapters implement this interface. No policy logic here. */
import type { PersistenceError, ConcurrencyError } from "../../persistence/errors"

export interface ContractRecord {
  contractId: string; familyId: string; version: number
  title: string; description: string; inScope: string; outOfScope: string
  payloadHash: string | null; repoUrl: string; repoSha: string
  createdBy: string; createdAt: string
}

export interface ContractLifecycleRecord {
  contractId: string; familyId: string; status: string
  activatedAt: string | null; supersededAt: string | null; archivedAt: string | null
  supersededBy: string | null; updatedTs: number
}

export interface RequirementRecord {
  id: string; contractId: string; title: string; description: string
  priority: string; sortOrder: number
}

export interface AcceptanceCriterionRecord {
  id: string; contractId: string; requirementId: string; title: string; description: string
  verificationMethod: string; priority: string; sortOrder: number
}

export interface VerificationRuleRecord {
  id: string; criterionId: string; ruleType: string; ruleConfig: string
  isRequired: boolean; verificationScope: string; failureClass: string
  isOverridable: boolean; evidenceRequirement: string
}

export interface ObjectiveRecord { id: string; contractId: string; sequence: number; description: string }
export interface ConstraintRecord { id: string; contractId: string; type: string; severity: string; description: string }

export interface ContractRepository {
  insertContract(record: ContractRecord): Promise<ContractRecord>
  getContract(id: string): Promise<ContractRecord | null>
  getContractByFamily(familyId: string, version: number): Promise<ContractRecord | null>
  updatePayloadHash(id: string, hash: string): Promise<void>

  insertLifecycle(record: ContractLifecycleRecord): Promise<ContractLifecycleRecord>
  getLifecycle(id: string): Promise<ContractLifecycleRecord | null>
  updateLifecycleStatus(id: string, status: string, activatedAt?: string): Promise<void>
  getActiveFamilyVersion(familyId: string): Promise<{ contractId: string; version: number } | null>
  supersedeActiveFamily(familyId: string, newContractId: string): Promise<void>

  insertRequirement(record: RequirementRecord): Promise<RequirementRecord>
  getRequirements(contractId: string): Promise<RequirementRecord[]>

  insertAcceptanceCriterion(record: AcceptanceCriterionRecord): Promise<AcceptanceCriterionRecord>
  getAcceptanceCriteria(contractId: string): Promise<AcceptanceCriterionRecord[]>

  insertVerificationRule(record: VerificationRuleRecord): Promise<VerificationRuleRecord>
  getVerificationRules(criterionId: string): Promise<VerificationRuleRecord[]>

  insertObjective(record: ObjectiveRecord): Promise<ObjectiveRecord>
  getObjectives(contractId: string): Promise<ObjectiveRecord[]>

  insertConstraint(record: ConstraintRecord): Promise<ConstraintRecord>
  getConstraints(contractId: string): Promise<ConstraintRecord[]>
}
