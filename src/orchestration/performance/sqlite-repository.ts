import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../persistence/transaction-manager"
import { performanceObservationSchema, scorePerformance, type PerformanceObservation, type PerformanceProfile } from "./contracts"

const bool = (value: boolean) => value ? 1 : 0
const parse = (value: unknown): string[] => { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(x => typeof x === "string") : [] } catch { return [] } }
export class SqlitePerformanceRepository {
  constructor(private readonly db: Database, private readonly tx: TransactionManager) {}
  saveObservation(observation: PerformanceObservation): PerformanceObservation {
    const o = performanceObservationSchema.parse(observation)
    return this.tx.write(() => {
      if (this.db.query("SELECT 1 FROM agent_performance_observations WHERE observation_id = ?").get(o.observationId)) throw new Error("PERFORMANCE_OBSERVATION_IMMUTABLE")
      try { this.db.query(`INSERT INTO agent_performance_observations (observation_id,run_id,workstream_id,agent_id,capability,task_class,strategy,complexity_band,risk_band,success,verification_passed,integration_passed,token_reserved,token_used,duration_ms,retry_count,review_findings,regression_count,termination_reason,usefulness_signals_json,policy_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.observationId, o.runId, o.workstreamId, o.agentId, o.capability, o.taskClass, o.strategy, o.complexityBand, o.riskBand, bool(o.success), bool(o.verificationPassed), bool(o.integrationPassed), o.tokenReserved, o.tokenUsed, o.durationMs, o.retryCount, o.reviewFindings, o.regressionCount, o.terminationReason, JSON.stringify(o.usefulnessSignals), o.policyVersion, o.createdAt) } catch { throw new Error("PERFORMANCE_OBSERVATION_DUPLICATE") }
      return o
    })
  }
  getObservation(id: string): PerformanceObservation | null { const row = this.db.query("SELECT * FROM agent_performance_observations WHERE observation_id = ?").get(id) as Record<string, unknown> | null; return row ? this.map(row) : null }
  listObservations(runId: string): PerformanceObservation[] { return (this.db.query("SELECT * FROM agent_performance_observations WHERE run_id = ? ORDER BY created_at, observation_id").all(runId) as Record<string, unknown>[]).map(r => this.map(r)) }
  profile(agentId: string, capability: string, minimumSamples = 3, windowMs = 90 * 24 * 60 * 60 * 1000): PerformanceProfile & { recencyStart: string } {
    const start = new Date(Date.now() - windowMs).toISOString(); const observations = (this.db.query("SELECT * FROM agent_performance_observations WHERE agent_id = ? AND capability = ? AND created_at >= ? ORDER BY created_at, observation_id").all(agentId, capability, start) as Record<string, unknown>[]).map(r => this.map(r)); return { ...scorePerformance(observations, agentId, capability, minimumSamples), recencyStart: start }
  }
  private map(r: Record<string, unknown>): PerformanceObservation { return performanceObservationSchema.parse({ observationId: r.observation_id, runId: r.run_id, workstreamId: r.workstream_id, agentId: r.agent_id, capability: r.capability, taskClass: r.task_class, strategy: r.strategy, complexityBand: r.complexity_band, riskBand: r.risk_band, success: Boolean(r.success), verificationPassed: Boolean(r.verification_passed), integrationPassed: Boolean(r.integration_passed), tokenReserved: r.token_reserved, tokenUsed: r.token_used, durationMs: r.duration_ms, retryCount: r.retry_count, reviewFindings: r.review_findings, regressionCount: r.regression_count, terminationReason: r.termination_reason, usefulnessSignals: parse(r.usefulness_signals_json), policyVersion: r.policy_version, createdAt: r.created_at }) }
}
