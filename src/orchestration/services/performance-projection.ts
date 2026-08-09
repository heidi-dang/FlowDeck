import type { PerformanceContext } from "../performance/contracts"
import type { SqlitePerformanceRepository } from "../performance/sqlite-repository"
export class PerformanceProjection {
  constructor(private readonly repository: SqlitePerformanceRepository) {}
  get(agentId: string, capability: string, context: PerformanceContext = {}): Record<string, unknown> { if (!/^[A-Za-z0-9._-]{1,200}$/.test(agentId) || !/^[A-Za-z0-9._-]{1,200}$/.test(capability)) throw new Error("INVALID_PERFORMANCE_ID"); if (context.taskClass !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(context.taskClass)) throw new Error("INVALID_PERFORMANCE_CONTEXT"); return { ...this.repository.profile(agentId, capability, 3, 90 * 24 * 60 * 60 * 1000, context) } }
}
