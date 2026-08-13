import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"

export type SkillMetadata = { name: string; description: string; requiredTools?: string[]; requiredCapabilities?: string[]; fallbackSkill?: string }
export function selectSkill(metadata: SkillMetadata[], availableTools: Set<string>, availableCapabilities: Set<string>): SkillMetadata[] { return metadata.filter(skill => (skill.requiredTools ?? []).every(t => availableTools.has(t)) && (skill.requiredCapabilities ?? []).every(c => availableCapabilities.has(c))) }
export function skillMetadataProjection(skills: SkillMetadata[]): string { return skills.map(s => `${s.name}: ${s.description}`).join("\n") }
export type PipelineOperation = { tool: string; args: Record<string, unknown> }
export async function executeToolPipeline(operations: PipelineOperation[], allowed: Set<string>, executor: (tool: string, args: Record<string, unknown>) => Promise<unknown>, limits: { maxCalls: number; timeoutMs: number; maxOutputBytes: number }): Promise<{ results: unknown[]; truncated: boolean }> {
  if (operations.length > limits.maxCalls) throw new Error("Tool pipeline operation limit exceeded")
  if (operations.some(op => !allowed.has(op.tool) || op.tool === "tool-pipeline")) throw new Error("Tool pipeline contains a disallowed tool")
  const result = await Promise.race([Promise.all(operations.map(op => executor(op.tool, op.args))), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Tool pipeline timed out")), limits.timeoutMs))])
  const raw = JSON.stringify(result); const bytes = Buffer.byteLength(raw, "utf8"); if (bytes <= limits.maxOutputBytes) return { results: result, truncated: false }
  return { results: [raw.slice(0, limits.maxOutputBytes)], truncated: true }
}

type RegisteredTool = { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown> }
let registeredTools: Record<string, RegisteredTool> = {}
export function configureHeidiPipelineTools(tools: Record<string, RegisteredTool>): void { registeredTools = { ...tools } }
export function getRegisteredPipelineExecutor(allowed: Set<string>, context: Record<string, unknown>): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (name, args) => { if (!allowed.has(name)) throw new Error(`PIPELINE_TOOL_NOT_ALLOWED:${name}`); const registered = registeredTools[name]; if (!registered) throw new Error(`PIPELINE_TOOL_NOT_REGISTERED:${name}`); return registered.execute(args, context) }
}

export class HeidiScheduler {
  constructor(private readonly db: Database) {}
  create(input: { name: string; prompt: string; scheduleType: "once" | "interval" | "cron"; schedule: string; timezone?: string; workspace: string }): unknown { const id = randomUUID(), now = new Date().toISOString(); this.db.query("INSERT INTO heidi_scheduled_jobs (id,name,prompt,schedule_type,schedule,timezone,workspace,created_at,updated_at,next_run_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id,input.name,input.prompt,input.scheduleType,input.schedule,input.timezone ?? "UTC",input.workspace,now,now,input.scheduleType === "once" ? input.schedule : now); return this.inspect(id) }
  list(): unknown[] { return this.db.query("SELECT * FROM heidi_scheduled_jobs ORDER BY created_at DESC").all() as unknown[] }
  inspect(id: string): unknown { return this.db.query("SELECT * FROM heidi_scheduled_jobs WHERE id=?").get(id) }
  update(id: string, input: { prompt?: string; schedule?: string; timezone?: string; workspace?: string }): unknown { const current = this.inspect(id) as Record<string, unknown> | null; if (!current) throw new Error("Scheduled job not found"); this.db.query("UPDATE heidi_scheduled_jobs SET prompt=?, schedule=COALESCE(?,schedule), timezone=COALESCE(?,timezone), workspace=COALESCE(?,workspace), next_run_at=COALESCE(?,next_run_at), updated_at=? WHERE id=?").run(input.prompt ?? String(current.prompt), input.schedule ?? null, input.timezone ?? null, input.workspace ?? null, input.schedule ?? null, new Date().toISOString(), id); return this.inspect(id) }
  setEnabled(id: string, enabled: boolean): void { this.db.query("UPDATE heidi_scheduled_jobs SET enabled=?, lease_until=NULL, updated_at=? WHERE id=?").run(enabled ? 1 : 0, new Date().toISOString(), id) }
  remove(id: string): void { this.db.query("DELETE FROM heidi_scheduled_jobs WHERE id=?").run(id) }
  history(id: string): unknown[] { return this.db.query("SELECT * FROM heidi_scheduled_runs WHERE job_id=? ORDER BY started_at DESC").all(id) as unknown[] }
  runNow(id: string): unknown { const now = new Date().toISOString(); this.db.query("UPDATE heidi_scheduled_jobs SET next_run_at=?, enabled=1, lease_until=NULL, updated_at=? WHERE id=?").run(now, now, id); return this.claimDue(now) }
  finish(runId: string, state: "completed" | "failed" | "cancelled" | "unknown", error?: string): void { const run = this.db.query("SELECT job_id FROM heidi_scheduled_runs WHERE id=?").get(runId) as { job_id: string } | null; if (!run) throw new Error("Scheduled run not found"); const now = new Date().toISOString(); this.db.query("UPDATE heidi_scheduled_runs SET state=?, finished_at=?, error=? WHERE id=? AND state IN ('claimed','running')").run(state, now, error ?? null, runId); this.db.query("UPDATE heidi_scheduled_jobs SET lease_until=NULL, enabled=CASE WHEN schedule_type='once' THEN 0 ELSE enabled END, next_run_at=CASE WHEN schedule_type='once' THEN NULL WHEN schedule_type='interval' THEN datetime(?, '+' || CAST(schedule AS INTEGER) || ' seconds') ELSE next_run_at END, updated_at=? WHERE id=?").run(now, now, run.job_id) }
  dbRunState(runId: string, state: "running"): void { this.db.query("UPDATE heidi_scheduled_runs SET state=? WHERE id=? AND state='claimed'").run(state, runId) }
  claimDue(now = new Date().toISOString(), leaseMs = 60_000): unknown { const job = this.db.query("SELECT * FROM heidi_scheduled_jobs WHERE enabled=1 AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at LIMIT 1").get(now, now) as Record<string, unknown> | null; if (!job) return null; const lease = new Date(Date.now()+leaseMs).toISOString(); const occurrence = String(job.next_run_at); const runId = randomUUID(); this.db.exec("BEGIN IMMEDIATE"); try { const result = this.db.query("UPDATE heidi_scheduled_jobs SET lease_until=?, last_run_at=?, updated_at=? WHERE id=? AND enabled=1 AND (lease_until IS NULL OR lease_until < ?)").run(lease, occurrence, now, String(job.id), now); if (result.changes !== 1) { this.db.exec("ROLLBACK"); return null }; this.db.query("INSERT INTO heidi_scheduled_runs (id,job_id,occurrence,state,started_at) VALUES (?,?,?,?,?)").run(runId,String(job.id),occurrence,"claimed",now); this.db.exec("COMMIT"); return this.db.query("SELECT * FROM heidi_scheduled_runs WHERE id=?").get(runId) } catch (e) { this.db.exec("ROLLBACK"); throw e } }
}

export class HeidiSchedulerWorker {
  constructor(private readonly scheduler: HeidiScheduler, private readonly execute: (job: { id: string; prompt: string; workspace: string }) => Promise<void>) {}
  async runOnce(): Promise<{ status: string; runId?: string }> {
    const claimed = this.scheduler.claimDue() as { id: string; job_id: string } | null
    if (!claimed) return { status: "idle" }
    const job = this.scheduler.inspect(claimed.job_id) as { id: string; prompt: string; workspace: string } | null
    if (!job) { this.scheduler.finish(claimed.id, "unknown", "Job disappeared after claim"); return { status: "unknown", runId: claimed.id } }
    try {
      if (!job.workspace || !existsSync(job.workspace)) { this.scheduler.finish(claimed.id, "failed", "Scheduled workspace does not exist"); return { status: "failed", runId: claimed.id } }
      this.scheduler.dbRunState(claimed.id, "running")
      await this.execute(job)
      this.scheduler.finish(claimed.id, "completed")
      return { status: "completed", runId: claimed.id }
    } catch (error) { this.scheduler.finish(claimed.id, "unknown", String(error)); return { status: "unknown", runId: claimed.id } }
  }
}
