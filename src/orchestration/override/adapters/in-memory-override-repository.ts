import { OverrideRequest } from "../domain/override-request"
import type { OverrideRepository } from "../ports/override-repository"
import type { Instant } from "../../common/types"

export class InMemoryOverrideRepository implements OverrideRepository {
  private readonly requests = new Map<string, OverrideRequest>()

  async saveRequest(request: OverrideRequest): Promise<void> {
    const existing = this.requests.get(request.id)
    if (existing && existing.version >= request.version) {
      throw new Error(`Concurrency conflict: override ${request.id} version ${existing.version} >= ${request.version}`)
    }
    this.requests.set(request.id, request)
  }
  async getRequest(requestId: string): Promise<OverrideRequest | undefined> { return this.requests.get(requestId) }
  async listRequestsByRun(taskRunId: string): Promise<OverrideRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.taskRunId === taskRunId)
  }
  async listActiveOverridesByRun(taskRunId: string): Promise<OverrideRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.taskRunId === taskRunId && r.isActive)
  }
  async listRequestsByGate(gateId: string): Promise<OverrideRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.gateId === gateId)
  }
  async consume(requestId: string, decisionId: string, expectedVersion: number, consumedAt: Instant): Promise<void> {
    const existing = this.requests.get(requestId)
    if (!existing) throw new Error(`Override ${requestId} not found`)
    if (existing.version !== expectedVersion) {
      throw new Error(`Concurrency conflict: override ${requestId} version ${existing.version} != expected ${expectedVersion}`)
    }
    if (existing.status !== "approved") {
      throw new Error(`Cannot consume override ${requestId}: status is "${existing.status}"`)
    }
    const consumed = existing.consume(decisionId, consumedAt)
    this.requests.set(requestId, consumed)
  }
  clear(): void { this.requests.clear() }
}
