import type { ApprovalRequest } from "../domain/approval-request"
import type { ApprovalDecision } from "../domain/approval-decision"
import type { ApprovalRepository } from "../ports/approval-repository"

export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly requests = new Map<string, ApprovalRequest>()
  private readonly decisions = new Map<string, ApprovalDecision>()

  async saveRequest(request: ApprovalRequest): Promise<void> { this.requests.set(request.id, request) }
  async getRequest(requestId: string): Promise<ApprovalRequest | undefined> { return this.requests.get(requestId) }
  async listRequestsByRun(taskRunId: string): Promise<ApprovalRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.taskRunId === taskRunId)
  }
  async saveDecision(decision: ApprovalDecision): Promise<void> { this.decisions.set(decision.id, decision) }
  async getDecision(decisionId: string): Promise<ApprovalDecision | undefined> { return this.decisions.get(decisionId) }
  async listDecisionsByRequest(requestId: string): Promise<ApprovalDecision[]> {
    return Array.from(this.decisions.values()).filter((d) => d.requestId === requestId)
  }
  async listDecisionsByRun(taskRunId: string): Promise<ApprovalDecision[]> {
    return Array.from(this.decisions.values()).filter((d) => d.taskRunId === taskRunId)
  }
  clear(): void { this.requests.clear(); this.decisions.clear() }
}
