import { ApprovalRequest } from "../domain/approval-request"
import { ApprovalDecision } from "../domain/approval-decision"
import { ApprovalNotFoundError } from "../domain/errors"
import { validateApprovalDecision } from "../policies/approval-policy"
import { type ApprovalRepository } from "../ports/approval-repository"
import { type Clock } from "../../common/ports/clock"
import { type IdGenerator } from "../../common/ports/id-generator"

export interface CreateRequestInput {
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly gateId: string
  readonly sha: string
  readonly requester: string
  readonly requesterAuthority: string
  readonly reason: string
  readonly expiresAt?: Date
}

export interface CreateDecisionInput {
  readonly requestId: string
  readonly outcome: "approved" | "rejected"
  readonly approver: string
  readonly approverAuthority: string
  readonly reason: string
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly expectedContractVersionId: string
  readonly allowSelfApproval: boolean
  readonly policyVersion: string
}

export class ApprovalService {
  constructor(private readonly repository: ApprovalRepository) {}

  async createRequest(input: CreateRequestInput, clock: Clock, idGen: IdGenerator): Promise<ApprovalRequest> {
    const request = new ApprovalRequest({
      id: idGen.generate(),
      taskRunId: input.taskRunId,
      contractVersionId: input.contractVersionId,
      contractFamilyId: input.contractFamilyId,
      gateId: input.gateId,
      sha: input.sha,
      requester: input.requester,
      requesterAuthority: input.requesterAuthority,
      reason: input.reason,
      status: "pending",
      createdAt: clock.now(),
      expiresAt: input.expiresAt,
    })
    await this.repository.saveRequest(request)
    return request
  }

  async submitDecision(input: CreateDecisionInput, clock: Clock, idGen: IdGenerator): Promise<ApprovalDecision> {
    const request = await this.repository.getRequest(input.requestId)
    if (!request) throw new ApprovalNotFoundError(input.requestId)

    const decision = new ApprovalDecision({
      id: idGen.generate(),
      requestId: input.requestId,
      taskRunId: request.taskRunId,
      contractFamilyId: request.contractFamilyId,
      contractVersionId: request.contractVersionId,
      gateId: request.gateId,
      sha: request.sha,
      outcome: input.outcome,
      approver: input.approver,
      approverAuthority: input.approverAuthority,
      reason: input.reason,
      createdAt: clock.now(),
      policyVersion: input.policyVersion,
    })

    validateApprovalDecision({
      request,
      decision,
      expectedTaskRunId: input.expectedTaskRunId,
      expectedSha: input.expectedSha,
      expectedContractVersionId: input.expectedContractVersionId,
      now: clock.now(),
      allowSelfApproval: input.allowSelfApproval,
    })

    const updatedRequest = input.outcome === "approved"
      ? request.approve(input.approver, input.reason, clock.now())
      : request.reject(input.approver, input.reason, clock.now())

    await this.repository.saveRequest(updatedRequest)
    await this.repository.saveDecision(decision)
    return decision
  }
}
