import { OverrideRequest } from "../domain/override-request"
import { OverrideNotFoundError } from "../domain/errors"
import { checkDuplicateActiveOverride } from "../policies/override-policy"
import { type OverrideRepository } from "../ports/override-repository"
import { type AuthorityLevel, type Instant, toInstant } from "../../common/types"

export interface CreateOverrideInput {
  readonly gateId: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly sha: string
  readonly justification: string
  readonly requester: string
  readonly requesterAuthority: AuthorityLevel
  readonly failureClass?: string
  readonly expiresAt?: Instant
}

export class OverrideService {
  constructor(private readonly repository: OverrideRepository) {}

  async createRequest(input: CreateOverrideInput): Promise<OverrideRequest> {
    const existing = await this.repository.listActiveOverridesByRun(input.taskRunId)
    if (checkDuplicateActiveOverride(existing, input.gateId, input.taskRunId)) {
      throw new Error(`An active override already exists for gate ${input.gateId} in run ${input.taskRunId}`)
    }

    const request = new OverrideRequest({
      id: `${input.taskRunId}-override-${Date.now()}`,
      gateId: input.gateId, taskRunId: input.taskRunId,
      contractVersionId: input.contractVersionId, contractFamilyId: input.contractFamilyId,
      sha: input.sha, justification: input.justification,
      requester: input.requester, requesterAuthority: input.requesterAuthority,
      status: "requested", version: 1,
      failureClass: input.failureClass,
      createdAt: toInstant(new Date()),
      expiresAt: input.expiresAt,
    })
    await this.repository.saveRequest(request)
    return request
  }

  async approveRequest(requestId: string, approver: string, approverAuthority: AuthorityLevel): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    const approved = request.approve(approver, approverAuthority, toInstant(new Date()))
    await this.repository.saveRequest(approved)
    return approved
  }

  async rejectRequest(requestId: string, approver: string): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    const rejected = request.reject(approver, toInstant(new Date()))
    await this.repository.saveRequest(rejected)
    return rejected
  }

  /** Consumes an override atomically — requires compare-and-set in persistence. */
  async consumeOverride(requestId: string, decisionId: string): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    if (request.status !== "approved") {
      throw new Error(`Cannot consume override ${requestId}: status is "${request.status}", expected "approved"`)
    }
    const consumed = request.consume(decisionId, toInstant(new Date()))
    await this.repository.saveRequest(consumed)
    return consumed
  }
}
