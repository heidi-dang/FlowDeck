import type { SqlitePerformanceRepository } from "../performance/sqlite-repository"
export class PerformanceProjection {
  constructor(private readonly repository: SqlitePerformanceRepository) {}
  get(agentId: string, capability: string): Record<string, unknown> { if (!/^[A-Za-z0-9._-]{1,200}$/.test(agentId) || !/^[A-Za-z0-9._-]{1,200}$/.test(capability)) throw new Error("INVALID_PERFORMANCE_ID"); return { ...this.repository.profile(agentId, capability) } }
}
