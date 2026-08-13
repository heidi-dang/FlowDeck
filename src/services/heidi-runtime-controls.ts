import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

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

export class HeidiScheduler {
  constructor(private readonly db: Database) {}
  create(input: { name: string; prompt: string; scheduleType: "once" | "interval" | "cron"; schedule: string; timezone?: string; workspace: string }): unknown { const id = randomUUID(), now = new Date().toISOString(); this.db.query("INSERT INTO heidi_scheduled_jobs (id,name,prompt,schedule_type,schedule,timezone,workspace,created_at,updated_at,next_run_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id,input.name,input.prompt,input.scheduleType,input.schedule,input.timezone ?? "UTC",input.workspace,now,now,input.scheduleType === "once" ? input.schedule : now); return this.inspect(id) }
  list(): unknown[] { return this.db.query("SELECT * FROM heidi_scheduled_jobs ORDER BY created_at DESC").all() as unknown[] }
  inspect(id: string): unknown { return this.db.query("SELECT * FROM heidi_scheduled_jobs WHERE id=?").get(id) }
  claimDue(now = new Date().toISOString(), leaseMs = 60_000): unknown { const job = this.db.query("SELECT * FROM heidi_scheduled_jobs WHERE enabled=1 AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at LIMIT 1").get(now, now) as Record<string, unknown> | null; if (!job) return null; const lease = new Date(Date.now()+leaseMs).toISOString(); const occurrence = String(job.next_run_at); const runId = randomUUID(); this.db.exec("BEGIN IMMEDIATE"); try { const result = this.db.query("UPDATE heidi_scheduled_jobs SET lease_until=?, last_run_at=?, updated_at=? WHERE id=? AND enabled=1 AND (lease_until IS NULL OR lease_until < ?)").run(lease, occurrence, now, String(job.id), now); if (result.changes !== 1) { this.db.exec("ROLLBACK"); return null }; this.db.query("INSERT INTO heidi_scheduled_runs (id,job_id,occurrence,state,started_at) VALUES (?,?,?,?,?)").run(runId,String(job.id),occurrence,"claimed",now); this.db.exec("COMMIT"); return this.db.query("SELECT * FROM heidi_scheduled_runs WHERE id=?").get(runId) } catch (e) { this.db.exec("ROLLBACK"); throw e } }
}
