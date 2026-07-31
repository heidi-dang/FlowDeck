/** SQLite adapter for ContractRepository. No policy logic. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import type { ContractRepository, ContractRecord, ContractLifecycleRecord, RequirementRecord, AcceptanceCriterionRecord, VerificationRuleRecord, ObjectiveRecord, ConstraintRecord } from "../../domain/ports/contract-repository"

export class SqliteContractAdapter implements ContractRepository {
  constructor(private db: Database, private tx: TransactionManager) {}
  async insertContract(r: ContractRecord): Promise<ContractRecord> {
    return this.tx.write(() => {
      this.db.query(`INSERT INTO task_contracts (contract_id,family_id,version,title,description,in_scope,out_of_scope,payload_hash,repo_url,repo_sha,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(r.contractId,r.familyId,r.version,r.title,r.description,r.inScope,r.outOfScope,r.payloadHash,r.repoUrl,r.repoSha,r.createdBy)
      return this.db.query("SELECT * FROM task_contracts WHERE contract_id=?").get(r.contractId) as any
    }) as any
  }
  async getContract(id: string): Promise<ContractRecord | null> {
    const r = this.db.query("SELECT * FROM task_contracts WHERE contract_id=?").get(id) as any; return r ? mapC(r) : null
  }
  async getContractByFamily(familyId: string, version: number): Promise<ContractRecord | null> {
    const r = this.db.query("SELECT * FROM task_contracts WHERE family_id=? AND version=?").get(familyId, version) as any; return r ? mapC(r) : null
  }
  async updatePayloadHash(id: string, hash: string): Promise<void> {
    this.tx.write(() => { this.db.query("UPDATE task_contracts SET payload_hash=? WHERE contract_id=?").run(hash, id) })
  }
  async insertLifecycle(r: ContractLifecycleRecord): Promise<ContractLifecycleRecord> {
    return this.tx.write(() => {
      this.db.query("INSERT INTO contract_lifecycle (contract_id,family_id,status,activated_at,superseded_at,archived_at,superseded_by,updated_ts) VALUES (?,?,?,?,?,?,?,?)").run(r.contractId,r.familyId,r.status,r.activatedAt,r.supersededAt,r.archivedAt,r.supersededBy,r.updatedTs)
      return this.db.query("SELECT * FROM contract_lifecycle WHERE contract_id=?").get(r.contractId) as any
    }) as any
  }
  async getLifecycle(id: string): Promise<ContractLifecycleRecord | null> {
    const r = this.db.query("SELECT * FROM contract_lifecycle WHERE contract_id=?").get(id) as any
    return r ? { contractId: r.contract_id, familyId: r.family_id, status: r.status, activatedAt: r.activated_at, supersededAt: r.superseded_at, archivedAt: r.archived_at, supersededBy: r.superseded_by, updatedTs: r.updated_ts } : null
  }
  async updateLifecycleStatus(id: string, status: string, activatedAt?: string): Promise<void> {
    this.tx.write(() => {
      if (activatedAt) this.db.query("UPDATE contract_lifecycle SET status=?,activated_at=?,updated_ts=strftime('%s','now') WHERE contract_id=?").run(status, activatedAt, id)
      else this.db.query("UPDATE contract_lifecycle SET status=?,updated_ts=strftime('%s','now') WHERE contract_id=?").run(status, id)
    })
  }
  async getActiveFamilyVersion(familyId: string): Promise<{ contractId: string; version: number } | null> {
    const r = this.db.query("SELECT cl.contract_id,tc.version FROM contract_lifecycle cl JOIN task_contracts tc ON tc.contract_id=cl.contract_id WHERE cl.family_id=? AND cl.status='active'").get(familyId) as any
    return r ? { contractId: r.contract_id, version: r.version } : null
  }
  async supersedeActiveFamily(familyId: string, newContractId: string): Promise<void> {
    this.tx.write(() => { this.db.query("UPDATE contract_lifecycle SET status='superseded',superseded_at=datetime('now'),superseded_by=?,updated_ts=strftime('%s','now') WHERE family_id=? AND status='active'").run(newContractId, familyId) })
  }
  async insertRequirement(r: RequirementRecord): Promise<RequirementRecord> {
    return this.tx.write(() => { this.db.query("INSERT INTO requirements (id,contract_id,title,description,priority,sort_order) VALUES (?,?,?,?,?,?)").run(r.id,r.contractId,r.title,r.description,r.priority,r.sortOrder); return r })
  }
  async getRequirements(contractId: string): Promise<RequirementRecord[]> {
    return (this.db.query("SELECT * FROM requirements WHERE contract_id=? ORDER BY sort_order").all(contractId) as any[]).map(r => ({ id: r.id, contractId: r.contract_id, title: r.title, description: r.description, priority: r.priority, sortOrder: r.sort_order }))
  }
  async insertAcceptanceCriterion(r: AcceptanceCriterionRecord): Promise<AcceptanceCriterionRecord> {
    return this.tx.write(() => { this.db.query("INSERT INTO acceptance_criteria (id,contract_id,requirement_id,title,description,verification_method,priority,sort_order) VALUES (?,?,?,?,?,?,?,?)").run(r.id,r.contractId,r.requirementId,r.title,r.description,r.verificationMethod,r.priority,r.sortOrder); return r })
  }
  async getAcceptanceCriteria(contractId: string): Promise<AcceptanceCriterionRecord[]> {
    return (this.db.query("SELECT * FROM acceptance_criteria WHERE contract_id=? ORDER BY sort_order").all(contractId) as any[]).map(r => ({ id: r.id, contractId: r.contract_id, requirementId: r.requirement_id, title: r.title, description: r.description, verificationMethod: r.verification_method, priority: r.priority, sortOrder: r.sort_order }))
  }
  async insertVerificationRule(r: VerificationRuleRecord): Promise<VerificationRuleRecord> {
    return this.tx.write(() => {
      this.db.query("INSERT INTO verification_rules (id,criterion_id,rule_type,rule_config,is_required,verification_scope,failure_class,is_overridable,evidence_requirement) VALUES (?,?,?,?,?,?,?,?,?)").run(r.id,r.criterionId,r.ruleType,r.ruleConfig,r.isRequired?1:0,r.verificationScope,r.failureClass,r.isOverridable?1:0,r.evidenceRequirement)
      return r
    })
  }
  async getVerificationRules(criterionId: string): Promise<VerificationRuleRecord[]> {
    return (this.db.query("SELECT * FROM verification_rules WHERE criterion_id=?").all(criterionId) as any[]).map(r => ({ id: r.id, criterionId: r.criterion_id, ruleType: r.rule_type, ruleConfig: r.rule_config, isRequired: !!r.is_required, verificationScope: r.verification_scope, failureClass: r.failure_class, isOverridable: !!r.is_overridable, evidenceRequirement: r.evidence_requirement }))
  }
  async insertObjective(r: ObjectiveRecord): Promise<ObjectiveRecord> {
    return this.tx.write(() => { this.db.query("INSERT INTO objectives (id,contract_id,sequence,description) VALUES (?,?,?,?)").run(r.id,r.contractId,r.sequence,r.description); return r })
  }
  async getObjectives(contractId: string): Promise<ObjectiveRecord[]> {
    return (this.db.query("SELECT * FROM objectives WHERE contract_id=? ORDER BY sequence").all(contractId) as any[]).map(r => ({ id: r.id, contractId: r.contract_id, sequence: r.sequence, description: r.description }))
  }
  async insertConstraint(r: ConstraintRecord): Promise<ConstraintRecord> {
    return this.tx.write(() => { this.db.query("INSERT INTO constraints (id,contract_id,type,severity,description) VALUES (?,?,?,?,?)").run(r.id,r.contractId,r.type,r.severity,r.description); return r })
  }
  async getConstraints(contractId: string): Promise<ConstraintRecord[]> {
    return (this.db.query("SELECT * FROM constraints WHERE contract_id=? ORDER BY type,severity").all(contractId) as any[]).map(r => ({ id: r.id, contractId: r.contract_id, type: r.type, severity: r.severity, description: r.description }))
  }
}
function mapC(r: any): ContractRecord { return { contractId: r.contract_id, familyId: r.family_id, version: r.version, title: r.title, description: r.description, inScope: r.in_scope, outOfScope: r.out_of_scope, payloadHash: r.payload_hash, repoUrl: r.repo_url, repoSha: r.repo_sha, createdBy: r.created_by, createdAt: r.created_at } }
