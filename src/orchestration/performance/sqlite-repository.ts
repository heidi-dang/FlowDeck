import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../persistence/transaction-manager"
import type { OrchestrationMetrics } from "../metrics"
import { PERFORMANCE_POLICY_VERSION, performanceObservationSchema, scorePerformance, type PerformanceContext, type PerformanceObservation, type PerformanceProfile } from "./contracts"

const bool = (value: boolean) => value ? 1 : 0
const parse = (value: unknown): string[] => { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(x => typeof x === "string") : [] } catch { return [] } }
export interface PerformanceOutcomeFacts { status: "succeeded" | "failed"; verificationPassed?: boolean; integrationPassed: boolean; tokenReserved?: number; tokenUsed?: number; reservationId?: string; durationMs?: number; retryCount?: number; reviewFindings?: number; regressionCount?: number; terminationReason?: string; usefulnessSignals?: string[] }
const band = (score: number): "low" | "medium" | "high" => score >= 70 ? "high" : score >= 40 ? "medium" : "low"
export class SqlitePerformanceRepository {
  constructor(private readonly db: Database, private readonly tx: TransactionManager, private readonly metrics?: OrchestrationMetrics) {}
  saveObservation(observation: PerformanceObservation): PerformanceObservation {
    const o = performanceObservationSchema.parse(observation)
    return this.tx.write(() => {
      if (this.db.query("SELECT 1 FROM agent_performance_observations WHERE observation_id = ?").get(o.observationId)) throw new Error("PERFORMANCE_OBSERVATION_IMMUTABLE")
      try { this.db.query(`INSERT INTO agent_performance_observations (observation_id,run_id,workstream_id,agent_id,capability,task_class,strategy,complexity_band,risk_band,success,verification_passed,integration_passed,token_reserved,token_used,duration_ms,retry_count,review_findings,regression_count,termination_reason,usefulness_signals_json,policy_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.observationId, o.runId, o.workstreamId, o.agentId, o.capability, o.taskClass, o.strategy, o.complexityBand, o.riskBand, bool(o.success), bool(o.verificationPassed), bool(o.integrationPassed), o.tokenReserved, o.tokenUsed, o.durationMs, o.retryCount, o.reviewFindings, o.regressionCount, o.terminationReason, JSON.stringify(o.usefulnessSignals), o.policyVersion, o.createdAt) } catch { throw new Error("PERFORMANCE_OBSERVATION_DUPLICATE") }
      this.metrics?.performanceObservations.inc()
      return o
    })
  }
  recordIntegratedWorkstream(workstream: { workstreamId: string; runId: string; resolvedAgent: string; requiredCapability: string; strategy: string; budgetProfile: string }, verificationPassed: boolean, durationMs: number): PerformanceObservation {
    const band = workstream.budgetProfile === "deep-audit" || workstream.budgetProfile === "audit" ? "high" : workstream.budgetProfile === "normal" ? "medium" : "low"
    return this.saveObservation({ observationId: `perf:${workstream.workstreamId}`, runId: workstream.runId, workstreamId: workstream.workstreamId, agentId: workstream.resolvedAgent, capability: workstream.requiredCapability, taskClass: "unknown", strategy: workstream.strategy, complexityBand: band, riskBand: workstream.strategy === "security_review" ? "high" : "low", success: verificationPassed, verificationPassed, integrationPassed: true, tokenReserved: 0, tokenUsed: 0, durationMs, retryCount: 0, reviewFindings: 0, regressionCount: 0, terminationReason: "integrated", usefulnessSignals: ["integrated_worktree"], policyVersion: PERFORMANCE_POLICY_VERSION, createdAt: new Date().toISOString() })
  }
  recordWorkstreamOutcome(workstream: { workstreamId: string; planId: string; runId: string; resolvedAgent: string; requiredCapability: string; strategy: string; budgetProfile: string }, facts: PerformanceOutcomeFacts): PerformanceObservation {
    const observationId = `perf:${workstream.runId}:${workstream.workstreamId}`
    const existing = this.getObservation(observationId)
    if (existing) return existing
    const planRow = this.db.query("SELECT run_id, routing_decision_id, policy_version FROM execution_plans WHERE plan_id = ?").get(workstream.planId) as { run_id: string; routing_decision_id: string; policy_version: string } | null
    if (planRow && planRow.run_id !== workstream.runId) throw new Error("PERFORMANCE_RUN_MISMATCH")
    let taskClass = "unknown"; let complexity = 50; let risk = 0
    if (planRow) {
      const decision = this.db.query("SELECT data FROM events WHERE event_id = ? AND event_type = 'routing.decision.finalized'").get(planRow.routing_decision_id) as { data: string } | null
      if (decision) {
        try { const parsed = JSON.parse(decision.data) as { assessment?: { taskClass?: string; complexity?: { score?: number }; risk?: { score?: number } } }; taskClass = parsed.assessment?.taskClass ?? taskClass; complexity = Number(parsed.assessment?.complexity?.score ?? complexity); risk = Number(parsed.assessment?.risk?.score ?? risk) } catch { /* malformed historical decision remains diagnosable as unknown */ }
      }
    }
    const verificationPassed = facts.verificationPassed === true
    return this.saveObservation({ observationId, runId: workstream.runId, workstreamId: workstream.workstreamId, agentId: workstream.resolvedAgent, capability: workstream.requiredCapability, taskClass, strategy: workstream.strategy, complexityBand: band(complexity), riskBand: band(risk), success: facts.status === "succeeded" && verificationPassed && facts.integrationPassed, verificationPassed, integrationPassed: facts.integrationPassed, tokenReserved: Math.max(0, facts.tokenReserved ?? 0), tokenUsed: Math.max(0, facts.tokenUsed ?? 0), durationMs: Math.max(0, facts.durationMs ?? 0), retryCount: Math.max(0, facts.retryCount ?? 0), reviewFindings: Math.max(0, facts.reviewFindings ?? 0), regressionCount: Math.max(0, facts.regressionCount ?? 0), terminationReason: facts.terminationReason ?? (facts.integrationPassed ? "integrated" : facts.status), usefulnessSignals: facts.usefulnessSignals ?? (facts.integrationPassed ? ["integrated_worktree"] : ["execution_terminal"]), policyVersion: planRow?.policy_version ?? PERFORMANCE_POLICY_VERSION, createdAt: new Date().toISOString() })
  }
  getObservation(id: string): PerformanceObservation | null { const row = this.db.query("SELECT * FROM agent_performance_observations WHERE observation_id = ?").get(id) as Record<string, unknown> | null; return row ? this.map(row) : null }
  listObservations(runId: string): PerformanceObservation[] { return (this.db.query("SELECT * FROM agent_performance_observations WHERE run_id = ? ORDER BY created_at, observation_id").all(runId) as Record<string, unknown>[]).map(r => this.map(r)) }
  profile(agentId: string, capability: string, minimumSamples = 3, windowMs = 90 * 24 * 60 * 60 * 1000, context: PerformanceContext = {}): PerformanceProfile & { recencyStart: string } {
    const start = new Date(Date.now() - windowMs).toISOString()
    const conditions = ["agent_id = ?", "capability = ?", "created_at >= ?"]
    const values: (string | number)[] = [agentId, capability, start]
    if (context.taskClass) { conditions.push("task_class = ?"); values.push(context.taskClass) }
    if (context.complexityBand) { conditions.push("complexity_band = ?"); values.push(context.complexityBand) }
    if (context.riskBand) { conditions.push("risk_band = ?"); values.push(context.riskBand) }
    const observations = (this.db.query(`SELECT * FROM agent_performance_observations WHERE ${conditions.join(" AND ")} ORDER BY created_at, observation_id`).all(...values) as Record<string, unknown>[]).map(r => this.map(r))
    const profile = scorePerformance(observations, agentId, capability, minimumSamples, context); this.metrics?.recordPerformanceProfile(profile.eligible); return { ...profile, recencyStart: start }
  }
  private map(r: Record<string, unknown>): PerformanceObservation { return performanceObservationSchema.parse({ observationId: r.observation_id, runId: r.run_id, workstreamId: r.workstream_id, agentId: r.agent_id, capability: r.capability, taskClass: r.task_class, strategy: r.strategy, complexityBand: r.complexity_band, riskBand: r.risk_band, success: Boolean(r.success), verificationPassed: Boolean(r.verification_passed), integrationPassed: Boolean(r.integration_passed), tokenReserved: r.token_reserved, tokenUsed: r.token_used, durationMs: r.duration_ms, retryCount: r.retry_count, reviewFindings: r.review_findings, regressionCount: r.regression_count, terminationReason: r.termination_reason, usefulnessSignals: parse(r.usefulness_signals_json), policyVersion: r.policy_version, createdAt: r.created_at }) }
}
