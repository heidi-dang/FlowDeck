import type { ApprovalRequest } from "../domain/approval-request"
import type { ApprovalDecision } from "../domain/approval-decision"

export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): Promise<void>
  getRequest(requestId: string): Promise<ApprovalRequest | undefined>
  listRequestsByRun(taskRunId: string): Promise<ApprovalRequest[]>
  saveDecision(decision: ApprovalDecision): Promise<void>
  getDecision(decisionId: string): Promise<ApprovalDecision | undefined>
  listDecisionsByRequest(requestId: string): Promise<ApprovalDecision[]>
  listDecisionsByRun(taskRunId: string): Promise<ApprovalDecision[]>
}
