import { ApprovalRequest } from "../domain/approval-request"
import { ApprovalDecision } from "../domain/approval-decision"
import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY } from "../domain/approval-policy"
import { ApprovalNotFoundError } from "../domain/errors"
import { validateApprovalBinding } from "../policies/approval-policy"
import { type ApprovalRepository } from "../ports/approval-repository"
import { type AuthorityLevel, type Instant, type PolicyVersion, toInstant } from "../../common/types"

export interface CreateRequestInput {
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly gateId: string
  readonly sha: string
  readonly requester: string
  readonly requesterAuthority: AuthorityLevel
  readonly reason: string
  readonly expiresAt?: Instant
}

export interface CreateDecisionInput {
  readonly requestId: string
  readonly outcome: "approved" | "rejected"
  readonly approver: string
  readonly approverAuthority: AuthorityLevel
  readonly reason: string
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly expectedContractVersionId: string
  readonly policyVersion: PolicyVersion
  readonly approvalPolicy?: ApprovalPolicy
}

export class ApprovalService {
  constructor(private readonly repository: ApprovalRepository) {}

  async createRequest(input: CreateRequestInput): Promise<ApprovalRequest> {
    const request = new ApprovalRequest({
      id: `apr-${input.taskRunId}-${Date.now()}`,
      taskRunId: input.taskRunId,
      contractVersionId: input.contractVersionId,
      contractFamilyId: input.contractFamilyId,
      gateId: input.gateId,
      sha: input.sha,
      requester: input.requester,
      requesterAuthority: input.requesterAuthority,
      reason: input.reason,
      status: "pending",
      version: 1,
      createdAt: toInstant(new Date()),
      expiresAt: input.expiresAt,
    })
    await this.repository.saveRequest(request)
    return request
  }

  async submitDecision(input: CreateDecisionInput): Promise<ApprovalDecision> {
    const request = await this.repository.getRequest(input.requestId)
    if (!request) throw new ApprovalNotFoundError(input.requestId)
    const now = toInstant(new Date())

    const decision = new ApprovalDecision({
      id: `apd-${input.requestId}-${Date.now()}`,
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
      createdAt: now,
      policyVersion: input.policyVersion,
    })

    const policy = input.approvalPolicy ?? DEFAULT_APPROVAL_POLICY

    validateApprovalBinding(
      request, decision,
      input.expectedTaskRunId, input.expectedSha, input.expectedContractVersionId,
      now, policy,
    )

    const updatedRequest = input.outcome === "approved"
      ? request.approve(input.approver, now)
      : request.reject(input.approver, input.reason, now)

    await this.repository.saveRequest(updatedRequest)
    await this.repository.saveDecision(decision)
    return decision
  }
}
