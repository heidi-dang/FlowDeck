import type { RoutingDecisionStore } from "../routing/store"
import { explainRouting } from "../routing/shadow"
import type { RunService } from "./run-service"
import { OrchestrationError, ErrorCodes } from "../types/errors"

export class RoutingProjection {
  constructor(private readonly store: RoutingDecisionStore, private readonly runs: RunService) {}

  async getForRun(runId: string): Promise<{ runId: string; decision: unknown; explanation: Record<string, unknown> }> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) throw OrchestrationError.fromCode(ErrorCodes.INVALID_FORMAT, { message: "Invalid run id" })
    await this.runs.getRun(runId)
    const decision = this.store.getLatestDecisionForRun(runId)
    if (!decision) throw OrchestrationError.fromCode(ErrorCodes.ROUTING_DECISION_NOT_FOUND, { message: `No routing decision for run ${runId}` })
    return { runId, decision, explanation: explainRouting(decision) }
  }
}
