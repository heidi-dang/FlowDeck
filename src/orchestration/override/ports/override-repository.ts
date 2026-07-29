import type { OverrideRequest } from "../domain/override-request"

export interface OverrideRepository {
  saveRequest(request: OverrideRequest): Promise<void>
  getRequest(requestId: string): Promise<OverrideRequest | undefined>
  listRequestsByRun(taskRunId: string): Promise<OverrideRequest[]>
  listActiveOverridesByRun(taskRunId: string): Promise<OverrideRequest[]>
  listRequestsByGate(gateId: string): Promise<OverrideRequest[]>
}
