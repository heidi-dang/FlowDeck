/** SQLite adapters for Dev 2 authoritative persistence ports. Self-contained — no external imports. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { ConcurrencyError } from "../errors"

// ── Local port type definitions (mirrors Dev 2 SHA 01cb85e) ─────
export interface FamilyData { id: string; name: string; description?: string; createdBy?: string; createdAt: Date }
export interface VerRunData { id: string; contractVersionId: string; targetSha: string; status: string; createdAt: Date; completedAt?: Date }
export interface VerResultData { id: string; runId: string; status: string; createdAt: Date }
export interface EvData { id: string; runId: string; sha: string; content: string; contentType: string; criterionIds: string[]; status: string; createdAt: Date }
export interface EvLinkData { evidenceId: string; criterionId: string; relationship: string }
export interface AppReqData { id: string; runId: string; requester: string; status: string; createdAt: Date }
export interface AppDecData { id: string; requestId: string; approver: string; decision: string; createdAt: Date }
export interface OvReqData { id: string; runId: string; overrideType: string; status: string; version: number; createdAt: Date }
export interface CompEvalData { id: string; contractVersionId: string; status: string; details: string; createdAt: Date }
export interface CompDecData { id: string; runId: string; decision: string; sha: string; details: string; createdAt: Date }
export interface IdemData { idempotencyKey: string; commandType: string; aggregateId: string; status: string; createdAt: Date }
export type ReservResult = { status: "acquired" | "completed" | "in_progress" | "conflict"; record: IdemData; expectedPayloadHash?: string; actualPayloadHash?: string }
export interface DomainEvData { id: string; type: string; data: Record<string, unknown>; timestamp: Date }

// ── Internal DB Row Typings ───────────────────────────────────────
interface ContractFamilyRow { family_id: string; name: string; description: string | null; created_by: string | null; created_at: string }
interface VerificationResultRow { id: string; run_id: string; target_sha: string; status: string; started_at: string; completed_at: string | null }
interface EvidenceRow { id: string; run_id: string; sha: string; content_hash: string; evidence_type: string; created_at: string }
interface RunCriterionEvidenceRow { evidence_id: string; run_acceptance_criterion_id: string; relationship: string }
interface CompletionOverrideRow { id: string; run_id: string; requester?: string; approved_by?: string; override_type: string; status?: string; created_at: string }
interface CompletionDecisionRow { id: string; run_id: string; decision: string; sha: string; checks: string; decided_at: string }

// ── ContractRepository ────────────────────────────────────────────
export class SqliteContractRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveFamily(f: FamilyData): Promise<void> {
    return this.tx.write(() => { this.db.query("INSERT INTO contract_families (family_id,name,description,created_by,created_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(family_id) DO UPDATE SET name=excluded.name,description=excluded.description").run(f.id,f.name,f.description??null,f.createdBy??'system') })
  }
  async getFamily(id: string): Promise<FamilyData | undefined> {
    const r = this.db.query("SELECT * FROM contract_families WHERE family_id=?").get(id) as ContractFamilyRow | null; if(!r)return undefined
    return { id: r.family_id, name: r.name, description: r.description ?? undefined, createdBy: r.created_by ?? undefined, createdAt: new Date(r.created_at) }
  }
  async listFamilies(): Promise<FamilyData[]> {
    return (this.db.query("SELECT * FROM contract_families ORDER BY name").all() as ContractFamilyRow[]).map(r => ({ id: r.family_id, name: r.name, description: r.description ?? undefined, createdBy: r.created_by ?? undefined, createdAt: new Date(r.created_at) }))
  }
  async deleteFamily(id: string): Promise<void> {
    this.tx.write(() => { this.db.query("DELETE FROM contract_families WHERE family_id=?").run(id) })
  }
}

// ── VerificationRepository ────────────────────────────────────────
export class SqliteVerificationRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveRun(r: VerRunData): Promise<void> {
    return this.tx.write(() => { this.db.query("INSERT INTO verification_results (id,run_id,verification_type,status,target_sha,started_at,completed_at) VALUES (?,?,'verification',?,?,datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at").run(r.id,r.contractVersionId,r.status,r.targetSha) })
  }
  async getRun(id: string): Promise<VerRunData | undefined> {
    const r = this.db.query("SELECT * FROM verification_results WHERE id=?").get(id) as VerificationResultRow | null; if(!r)return undefined
    return { id: r.id, contractVersionId: r.run_id, targetSha: r.target_sha, status: r.status, createdAt: new Date(r.started_at), completedAt: r.completed_at?new Date(r.completed_at):undefined }
  }
  async listRunsByContractVersion(v: string): Promise<VerRunData[]> {
    return (this.db.query("SELECT * FROM verification_results WHERE run_id=? ORDER BY started_at").all(v) as VerificationResultRow[]).map(r => ({ id: r.id, contractVersionId: r.run_id, targetSha: r.target_sha, status: r.status, createdAt: new Date(r.started_at), completedAt: r.completed_at?new Date(r.completed_at):undefined }))
  }
  async saveResult(result: VerResultData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO verification_results (id,run_id,verification_type,status,target_sha,started_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET status=excluded.status").run(result.id,result.runId,'result',result.status,"0".repeat(40)) })
  }
  async getResult(id: string): Promise<VerResultData | undefined> {
    const r = this.db.query("SELECT * FROM verification_results WHERE id=?").get(id) as VerificationResultRow | null; if(!r)return undefined
    return { id: r.id, runId: r.run_id, status: r.status, createdAt: new Date(r.started_at) }
  }
  async listResultsByRun(runId: string): Promise<VerResultData[]> {
    return (this.db.query("SELECT * FROM verification_results WHERE run_id=? ORDER BY started_at").all(runId) as VerificationResultRow[]).map(r => ({ id: r.id, runId: r.run_id, status: r.status, createdAt: new Date(r.started_at) }))
  }
  async listResultsByContractVersion(v: string): Promise<VerResultData[]> { return this.listResultsByRun(v) }
}

// ── EvidenceRepository ────────────────────────────────────────────
export class SqliteEvidenceRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveEvidence(e: EvData): Promise<void> {
    return this.tx.write(() => { this.db.query("INSERT INTO evidence (id,run_id,evidence_type,title,description,source,content_hash,sha,created_at) VALUES (?,?,?,?,?,?,?, ?,datetime('now')) ON CONFLICT(id) DO NOTHING").run(e.id,e.runId,e.contentType,e.content?.substring(0,80)??'ev',e.content,'command-verification',e.content,e.sha) })
  }
  async getEvidence(id: string): Promise<EvData | undefined> {
    const r = this.db.query("SELECT * FROM evidence WHERE id=?").get(id) as EvidenceRow | null; if(!r)return undefined
    return { id: r.id, runId: r.run_id, sha: r.sha, content: r.content_hash, contentType: r.evidence_type, criterionIds: [], status: 'current', createdAt: new Date(r.created_at) }
  }
  async listEvidenceByRun(runId: string): Promise<EvData[]> {
    return (this.db.query("SELECT * FROM evidence WHERE run_id=? ORDER BY created_at").all(runId) as EvidenceRow[]).map(r => ({ id: r.id, runId: r.run_id, sha: r.sha, content: r.content_hash, contentType: r.evidence_type, criterionIds: [], status: 'current', createdAt: new Date(r.created_at) }))
  }
  async listEvidenceByCriterion(_criterionId: string): Promise<EvData[]> { return [] }
  async listEvidenceBySha(sha: string): Promise<EvData[]> {
    return (this.db.query("SELECT * FROM evidence WHERE sha=? ORDER BY created_at").all(sha) as EvidenceRow[]).map(r => ({ id: r.id, runId: r.run_id, sha: r.sha, content: r.content_hash, contentType: r.evidence_type, criterionIds: [], status: 'current', createdAt: new Date(r.created_at) }))
  }
  async saveLink(link: EvLinkData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT OR IGNORE INTO run_criterion_evidence (run_acceptance_criterion_id,evidence_id,relationship,linked_at) VALUES (?,?,?,datetime('now'))").run(link.criterionId,link.evidenceId,link.relationship) })
  }
  async listLinksByEvidence(evidenceId: string): Promise<EvLinkData[]> {
    return (this.db.query("SELECT * FROM run_criterion_evidence WHERE evidence_id=?").all(evidenceId) as RunCriterionEvidenceRow[]).map(r => ({ evidenceId: r.evidence_id, criterionId: r.run_acceptance_criterion_id, relationship: r.relationship }))
  }
}

// ── ApprovalRepository ────────────────────────────────────────────
export class SqliteApprovalRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveRequest(r: AppReqData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO completion_overrides (id,run_id,override_type,target_id,reason,approved_by,approval_type,overridden_findings,created_at) VALUES (?,?,?,'pending','',?,'auto_policy','{}',datetime('now'))").run(r.id,r.runId,r.status,r.requester) })
  }
  async getRequest(id: string): Promise<AppReqData | undefined> {
    const r = this.db.query("SELECT id,run_id,approved_by as requester,override_type as status,created_at FROM completion_overrides WHERE id=?").get(id) as CompletionOverrideRow | null
    return r?{id:r.id,runId:r.run_id,requester:r.requester ?? r.approved_by ?? 'system',status:r.status ?? r.override_type,createdAt:new Date(r.created_at)}:undefined
  }
  async listRequestsByRun(taskRunId: string): Promise<AppReqData[]> {
    return (this.db.query("SELECT id,run_id,approved_by as requester,override_type as status,created_at FROM completion_overrides WHERE run_id=?").all(taskRunId) as CompletionOverrideRow[]).map(r => ({ id:r.id, runId:r.run_id, requester:r.requester ?? r.approved_by ?? 'system', status:r.status ?? r.override_type, createdAt:new Date(r.created_at) }))
  }
  async saveDecision(_d: AppDecData): Promise<void> { return }
  async getDecision(_id: string): Promise<AppDecData | undefined> { return undefined }
  async listDecisionsByRequest(_id: string): Promise<AppDecData[]> { return [] }
  async listDecisionsByRun(_id: string): Promise<AppDecData[]> { return [] }
}

// ── OverrideRepository ────────────────────────────────────────────
export class SqliteOverrideRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveRequest(r: OvReqData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO completion_overrides (id,run_id,override_type,target_id,reason,approved_by,approval_type,overridden_findings,created_at) VALUES (?,?,?,?,'','system','auto_policy','{}',datetime('now'))").run(r.id,r.runId,r.overrideType,r.id) })
  }
  async getRequest(id: string): Promise<OvReqData | undefined> {
    const r = this.db.query("SELECT id,run_id,override_type,created_at FROM completion_overrides WHERE id=?").get(id) as CompletionOverrideRow | null
    return r?{id:r.id,runId:r.run_id,overrideType:r.override_type,status:'approved',version:1,createdAt:new Date(r.created_at)}:undefined
  }
  async listRequestsByRun(taskRunId: string): Promise<OvReqData[]> {
    return (this.db.query("SELECT id,run_id,override_type,created_at FROM completion_overrides WHERE run_id=?").all(taskRunId) as CompletionOverrideRow[]).map(r => ({ id:r.id, runId:r.run_id, overrideType:r.override_type, status:'approved', version:1, createdAt:new Date(r.created_at) }))
  }
  async listActiveOverridesByRun(taskRunId: string): Promise<OvReqData[]> { return this.listRequestsByRun(taskRunId) }
  async listRequestsByGate(_gateId: string): Promise<OvReqData[]> { return [] }
  async consume(requestId: string, _decisionId: string, _expectedVersion: number, _consumedAt: string): Promise<void> {
    this.tx.write(() => { const r = this.db.query("UPDATE completion_overrides SET is_consumed=1 WHERE id=? AND is_consumed=0").run(requestId); if(r.changes===0) throw new ConcurrencyError(1, `consumed: ${requestId}`) })
  }
}

// ── CompletionRepository ──────────────────────────────────────────
export class SqliteCompletionRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async saveEvaluation(e: CompEvalData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO verification_results (id,run_id,verification_type,status,started_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET status=excluded.status").run(e.id,e.contractVersionId,'evaluation',e.status) })
  }
  async getLatestEvaluation(v: string): Promise<CompEvalData | undefined> {
    const r = this.db.query("SELECT id,run_id,status,started_at FROM verification_results WHERE run_id=? ORDER BY started_at DESC LIMIT 1").get(v) as VerificationResultRow | null
    return r?{id:r.id,contractVersionId:r.run_id,status:r.status,details:'',createdAt:new Date(r.started_at)}:undefined
  }
  async listEvaluations(v: string): Promise<CompEvalData[]> {
    return (this.db.query("SELECT id,run_id,status,started_at FROM verification_results WHERE run_id=? ORDER BY started_at").all(v) as VerificationResultRow[]).map(r => ({ id:r.id, contractVersionId:r.run_id, status:r.status, details:'', createdAt:new Date(r.started_at) }))
  }
  async saveDecision(d: CompDecData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO completion_decisions (id,run_id,decision,sha,checks,idempotency_key,decided_at) VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT DO NOTHING").run(d.id,d.runId,d.decision,d.sha,d.details,d.id) })
  }
  async getDecision(id: string): Promise<CompDecData | undefined> {
    const r = this.db.query("SELECT * FROM completion_decisions WHERE id=?").get(id) as CompletionDecisionRow | null; if(!r)return undefined
    return { id:r.id, runId:r.run_id, decision:r.decision, sha:r.sha, details:r.checks, createdAt:new Date(r.decided_at) }
  }
  async getLatestDecisionByRun(taskRunId: string): Promise<CompDecData | undefined> {
    const r = this.db.query("SELECT * FROM completion_decisions WHERE run_id=? ORDER BY decided_at DESC LIMIT 1").get(taskRunId) as CompletionDecisionRow | null
    return r?{id:r.id,runId:r.run_id,decision:r.decision,sha:r.sha,details:r.checks,createdAt:new Date(r.decided_at)}:undefined
  }
  async listDecisionsByRun(taskRunId: string): Promise<CompDecData[]> {
    return (this.db.query("SELECT * FROM completion_decisions WHERE run_id=? ORDER BY decided_at DESC").all(taskRunId) as CompletionDecisionRow[]).map(r => ({ id:r.id, runId:r.run_id, decision:r.decision, sha:r.sha, details:r.checks, createdAt:new Date(r.decided_at) }))
  }
  async supersedeDecision(_prev: string, _next: string): Promise<void> { return }
}

// ── IdempotencyRepository ─────────────────────────────────────────
export class SqliteIdempotencyRepoAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async tryReserve(commandType: string, aggregateId: string, idempotencyKey: string, _payloadHash: string, _createdAt: string): Promise<ReservResult> {
    try { return this.tx.write(() => { this.db.query("INSERT INTO command_idempotency (idempotency_key,command_type,aggregate_type,aggregate_id,status,started_at,created_ts) VALUES (?,?,'task_run',?,'executing',datetime('now'),strftime('%s','now'))").run(idempotencyKey,commandType,aggregateId); return {status:'acquired' as const,record:{idempotencyKey,commandType,aggregateId,status:'executing',createdAt:new Date()}} }) }
    catch { return {status:'conflict' as const,record:{idempotencyKey,commandType,aggregateId,status:'completed',createdAt:new Date()},expectedPayloadHash:_payloadHash,actualPayloadHash:''} }
  }
  async completeReservation(_ct: string, _aid: string, idempotencyKey: string, _rt: string, _rid: string, _at: string): Promise<void> {
    this.tx.write(() => { this.db.query("UPDATE command_idempotency SET status='completed',completed_at=datetime('now') WHERE idempotency_key=?").run(idempotencyKey) })
  }
  async releaseReservation(_ct: string, _aid: string, idempotencyKey: string, _at: string): Promise<void> {
    this.tx.write(() => { this.db.query("DELETE FROM command_idempotency WHERE idempotency_key=?").run(idempotencyKey) })
  }
}

// ── DomainEventAppender ───────────────────────────────────────────
export class SqliteEventAppenderAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}
  async append(event: DomainEvData): Promise<void> {
    this.tx.write(() => { this.db.query("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES (?,?,'task_run','unknown',1,datetime('now'),'{}','{}',strftime('%s','now'))").run(event.id,event.type) })
  }
  async appendMany(events: DomainEvData[]): Promise<void> {
    for (const e of events) await this.append(e)
  }
}
