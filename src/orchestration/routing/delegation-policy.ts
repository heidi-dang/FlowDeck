/**
 * Delegation Policy
 *
 * Determines whether a task should be delegated to a specialist or
 * handled by Heidi directly. Rejects delegation when:
 * - Task is trivial
 * - Specialist setup cost exceeds benefit
 * - Ownership overlaps
 * - Specialist provides no capability advantage
 * - Heidi can complete more efficiently
 */

export interface DelegationRequest {
  readonly taskId: string
  readonly taskComplexity: number
  readonly estimatedHeidiCost: number
  readonly estimatedSpecialistCost: number
  readonly specialistSetupCost: number
  readonly capabilityAdvantage: number
  readonly ownershipOverlap: "none" | "low" | "medium" | "high"
  readonly requestedCapability: string
  readonly agentId: string
}

export interface DelegationDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly expectedLatencyBenefit: number
  readonly estimatedTokenCost: number
  readonly overlapRisk: "none" | "low" | "medium" | "high"
  readonly actualOutcome?: "success" | "failure" | "skipped"
}

export class DelegationPolicy {
  private readonly TRIVIAL_COMPLEXITY_THRESHOLD = 1
  private readonly HIGH_OVERLAP_THRESHOLD = 0.7
  private readonly MIN_LATENCY_BENEFIT = 50
  private readonly MIN_CAPABILITY_ADVANTAGE = 0.1

  evaluate(request: DelegationRequest): DelegationDecision {
    // Reject trivial tasks
    if (request.taskComplexity <= this.TRIVIAL_COMPLEXITY_THRESHOLD) {
      return {
        allowed: false,
        reason: "Task is trivial - delegation overhead not justified",
        expectedLatencyBenefit: 0,
        estimatedTokenCost: request.estimatedSpecialistCost,
        overlapRisk: "none",
      }
    }

    // Reject when specialist setup cost exceeds benefit
    const netBenefit =
      request.estimatedSpecialistCost - request.specialistSetupCost - request.estimatedHeidiCost
    if (netBenefit < 0) {
      return {
        allowed: false,
        reason: "Specialist setup cost exceeds estimated benefit",
        expectedLatencyBenefit: 0,
        estimatedTokenCost: request.estimatedSpecialistCost,
        overlapRisk: request.ownershipOverlap,
      }
    }

    // Reject high ownership overlap
    if (request.ownershipOverlap === "high") {
      return {
        allowed: false,
        reason: "High ownership overlap - risk of conflicting changes",
        expectedLatencyBenefit: 0,
        estimatedTokenCost: request.estimatedSpecialistCost,
        overlapRisk: "high",
      }
    }

    // Reject when specialist provides no capability advantage
    if (request.capabilityAdvantage < this.MIN_CAPABILITY_ADVANTAGE) {
      return {
        allowed: false,
        reason: "Specialist provides insufficient capability advantage",
        expectedLatencyBenefit: 0,
        estimatedTokenCost: request.estimatedSpecialistCost,
        overlapRisk: request.ownershipOverlap,
      }
    }

    // Reject when Heidi can complete more efficiently
    const latencyBenefit = this.calculateLatencyBenefit(request)
    if (latencyBenefit < this.MIN_LATENCY_BENEFIT) {
      return {
        allowed: false,
        reason: "Heidi can complete task more efficiently",
        expectedLatencyBenefit: latencyBenefit,
        estimatedTokenCost: request.estimatedSpecialistCost,
        overlapRisk: request.ownershipOverlap,
      }
    }

    return {
      allowed: true,
      reason: "Delegation approved - specialist offers efficiency gain",
      expectedLatencyBenefit: latencyBenefit,
      estimatedTokenCost: request.estimatedSpecialistCost,
      overlapRisk: request.ownershipOverlap,
    }
  }

  private calculateLatencyBenefit(request: DelegationRequest): number {
    const heidiTime = request.estimatedHeidiCost / 1000 // Convert to ms equivalent
    const specialistTime = request.estimatedSpecialistCost / 1000
    return heidiTime - specialistTime
  }
}
