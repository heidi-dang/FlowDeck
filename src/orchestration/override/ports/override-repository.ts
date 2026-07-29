import type { OverrideRequest } from "../domain/override-request"
import type { Instant } from "../../common/types"

export interface OverrideRepository {
  saveRequest(request: OverrideRequest): Promise<void>
  getRequest(requestId: string): Promise<OverrideRequest | undefined>
  listRequestsByRun(taskRunId: string): Promise<OverrideRequest[]>
  listActiveOverridesByRun(taskRunId: string): Promise<OverrideRequest[]>
  listRequestsByGate(gateId: string): Promise<OverrideRequest[]>

  /** Optimistic consume — only succeeds if status is "approved" and version matches. */
  consume(requestId: string, decisionId: string, expectedVersion: number, consumedAt: Instant): Promise<void>
}
