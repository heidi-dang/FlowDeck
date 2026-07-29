import type { OverrideRequest } from "../domain/override-request"
import type { OverrideRepository } from "../ports/override-repository"

export class InMemoryOverrideRepository implements OverrideRepository {
  private readonly requests = new Map<string, OverrideRequest>()

  async saveRequest(request: OverrideRequest): Promise<void> { this.requests.set(request.id, request) }
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
  clear(): void { this.requests.clear() }
}
