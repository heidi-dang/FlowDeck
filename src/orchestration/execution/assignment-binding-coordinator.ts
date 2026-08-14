import { randomUUID } from "crypto"
import type { AssignmentService } from "../services/assignment-service"
import type { SqliteAssignmentExecutionBindingRepository, AssignmentExecutionBinding } from "./assignment-execution-binding-repository"
import type { ExecutionPlan } from "./contracts"

export interface AssignmentBindingCoordinatorDeps {
  assignmentService: AssignmentService
  bindingRepo: SqliteAssignmentExecutionBindingRepository
}

/**
 * Canonical coordinator that binds ExecutionPlan Workstreams to logical
 * Assignments and tracks bounded dispatch attempts.
 *
 * Both fresh command execution and fresh-runtime recovery use this same
 * coordinator, so the logical Assignment graph is never recreated and the
 * dispatch-attempt identity is durable. The (plan, workstream) UNIQUE
 * constraint makes `ensureAssignments` safe under concurrent recovery.
 */
export class AssignmentBindingCoordinator {
  constructor(private readonly deps: AssignmentBindingCoordinatorDeps) {}

  /**
   * Idempotently ensure one logical Assignment exists for every Workstream in
   * the plan. Returns a stable map of workstreamId -> assignmentId that is
   * identical across restarts because it is derived from the durable binding.
   */
  async ensureAssignments(plan: ExecutionPlan, correlationId: string): Promise<Map<string, string>> {
    const now = new Date().toISOString()
    const map = new Map<string, string>()
    for (const workstream of plan.workstreams) {
      const existing = this.deps.bindingRepo.getByPlanAndWorkstream(plan.planId, workstream.workstreamId)
      if (existing) {
        map.set(workstream.workstreamId, existing.assignmentId)
        continue
      }
      const assignmentId = randomUUID()
      // Reserve the binding first so a crash before assignment creation still
      // leaves a durable, reusable logical Assignment identity for recovery.
      this.deps.bindingRepo.ensureBinding(
        {
          assignmentId,
          runId: plan.runId,
          planId: plan.planId,
          workstreamId: workstream.workstreamId,
          correlationId,
        },
        now,
      )
      try {
        await this.deps.assignmentService.createAssignment({
          id: assignmentId,
          runId: plan.runId,
          agentId: workstream.resolvedAgent,
          role: workstream.requiredCapability,
          correlationId,
          contractId: plan.routingDecisionId,
          taskDescription: workstream.objective,
          metadata: { commandInvocationId: correlationId, executionPlanId: plan.planId, workstreamId: workstream.workstreamId },
        })
      } catch (error) {
        // If the assignment row already exists (e.g. a concurrent recoverer
        // created it), reuse the binding's identity rather than failing.
        const rebound = this.deps.bindingRepo.getByPlanAndWorkstream(plan.planId, workstream.workstreamId)
        if (!rebound) throw error
        map.set(workstream.workstreamId, rebound.assignmentId)
        continue
      }
      map.set(workstream.workstreamId, assignmentId)
    }
    return map
  }

  getBinding(assignmentId: string): AssignmentExecutionBinding | null {
    return this.deps.bindingRepo.getByAssignmentId(assignmentId)
  }

  listByPlan(planId: string): AssignmentExecutionBinding[] {
    return this.deps.bindingRepo.listByPlan(planId)
  }

  /** Record a durable dispatch attempt for a logical Assignment. */
  recordAttempt(assignmentId: string): AssignmentExecutionBinding {
    return this.deps.bindingRepo.recordAttempt(assignmentId, randomUUID(), new Date().toISOString())
  }

  markSucceeded(assignmentId: string): AssignmentExecutionBinding {
    return this.deps.bindingRepo.transition(assignmentId, "succeeded", new Date().toISOString())
  }

  markFailed(assignmentId: string): AssignmentExecutionBinding {
    return this.deps.bindingRepo.transition(assignmentId, "failed", new Date().toISOString())
  }

  markCancelled(assignmentId: string): AssignmentExecutionBinding {
    return this.deps.bindingRepo.transition(assignmentId, "cancelled", new Date().toISOString())
  }
}
