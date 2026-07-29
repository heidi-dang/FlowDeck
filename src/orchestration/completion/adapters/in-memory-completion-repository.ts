import type { CompletionEvaluation } from "../domain/evaluation"
import type { CompletionDecision } from "../decision/completion-decision"
import type { CompletionRepository } from "../ports/completion-repository"

export class InMemoryCompletionRepository implements CompletionRepository {
  private readonly evaluations = new Map<string, CompletionEvaluation>()
  private readonly decisions = new Map<string, CompletionDecision>()
  // Map<decisionId, supersededByDecisionId>
  private readonly supersessions = new Map<string, string>()
  private evalCounter = 0

  async saveEvaluation(evaluation: CompletionEvaluation): Promise<void> {
    this.evalCounter++
    this.evaluations.set(`eval-${this.evalCounter}`, evaluation)
  }
  async getLatestEvaluation(_contractVersionId: string): Promise<CompletionEvaluation | undefined> {
    const evals = Array.from(this.evaluations.values())
    return evals.length > 0 ? evals[evals.length - 1] : undefined
  }
  async listEvaluations(_contractVersionId: string): Promise<CompletionEvaluation[]> {
    return Array.from(this.evaluations.values())
  }

  async saveDecision(decision: CompletionDecision): Promise<void> {
    if (this.decisions.has(decision.id)) {
      throw new Error(`Concurrency conflict: decision ${decision.id} already exists`)
    }
    this.decisions.set(decision.id, decision)
  }
  async getDecision(decisionId: string): Promise<CompletionDecision | undefined> {
    return this.decisions.get(decisionId)
  }
  async getLatestDecisionByRun(taskRunId: string): Promise<CompletionDecision | undefined> {
    const runDecisions = Array.from(this.decisions.values())
      .filter((d) => d.taskRunId === taskRunId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return runDecisions.length > 0 ? runDecisions[runDecisions.length - 1] : undefined
  }
  async listDecisionsByRun(taskRunId: string): Promise<CompletionDecision[]> {
    return Array.from(this.decisions.values()).filter((d) => d.taskRunId === taskRunId)
  }
  async supersedeDecision(previousDecisionId: string, newDecisionId: string): Promise<void> {
    this.supersessions.set(previousDecisionId, newDecisionId)
  }
  clear(): void { this.evaluations.clear(); this.decisions.clear(); this.supersessions.clear() }
}
