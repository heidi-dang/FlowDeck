import { OverrideRequest } from "../domain/override-request"
import { OverrideNotFoundError } from "../domain/errors"
import { checkDuplicateActiveOverride } from "../policies/override-policy"
import { type OverrideRepository } from "../ports/override-repository"
import { type Clock } from "../../common/ports/clock"
import { type IdGenerator } from "../../common/ports/id-generator"

export interface CreateOverrideInput {
  readonly gateId: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly sha: string
  readonly justification: string
  readonly requester: string
  readonly requesterAuthority: string
  readonly failureClass?: string
  readonly expiresAt?: Date
}

export class OverrideService {
  constructor(private readonly repository: OverrideRepository) {}

  async createRequest(input: CreateOverrideInput, clock: Clock, idGen: IdGenerator): Promise<OverrideRequest> {
    const existing = await this.repository.listActiveOverridesByRun(input.taskRunId)
    if (checkDuplicateActiveOverride(existing, input.gateId, input.taskRunId)) {
      throw new Error(`An active override already exists for gate ${input.gateId} in run ${input.taskRunId}`)
    }

    const request = new OverrideRequest({
      id: idGen.generate(),
      gateId: input.gateId,
      taskRunId: input.taskRunId,
      contractVersionId: input.contractVersionId,
      contractFamilyId: input.contractFamilyId,
      sha: input.sha,
      justification: input.justification,
      requester: input.requester,
      requesterAuthority: input.requesterAuthority,
      status: "requested",
      failureClass: input.failureClass,
      createdAt: clock.now(),
      expiresAt: input.expiresAt,
    })
    await this.repository.saveRequest(request)
    return request
  }

  async approveRequest(requestId: string, approver: string, approverAuthority: string, clock: Clock): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    const approved = request.approve(approver, approverAuthority, clock.now())
    await this.repository.saveRequest(approved)
    return approved
  }

  async rejectRequest(requestId: string, approver: string, clock: Clock): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    const rejected = request.reject(approver, clock.now())
    await this.repository.saveRequest(rejected)
    return rejected
  }

  async consumeOverride(requestId: string, clock: Clock): Promise<OverrideRequest> {
    const request = await this.repository.getRequest(requestId)
    if (!request) throw new OverrideNotFoundError(requestId)
    const consumed = request.consume(clock.now())
    await this.repository.saveRequest(consumed)
    return consumed
  }
}
