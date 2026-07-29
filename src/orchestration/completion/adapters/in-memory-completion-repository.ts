import type { CompletionEvaluation } from "../domain/evaluation"
import type { CompletionDecision } from "../decision/completion-decision"
import type { CompletionRepository } from "../ports/completion-repository"

export class InMemoryCompletionRepository implements CompletionRepository {
  private readonly evaluations = new Map<string, CompletionEvaluation>()
  private readonly decisions = new Map<string, CompletionDecision>()

  async saveEvaluation(evaluation: CompletionEvaluation): Promise<void> {
    this.evaluations.set(`eval-${this.evaluations.size + 1}`, evaluation)
  }
  async getLatestEvaluation(_contractVersionId: string): Promise<CompletionEvaluation | undefined> {
    const evals = Array.from(this.evaluations.values())
    return evals.length > 0 ? evals[evals.length - 1] : undefined
  }
  async listEvaluations(_contractVersionId: string): Promise<CompletionEvaluation[]> {
    return Array.from(this.evaluations.values())
  }

  async saveDecision(decision: CompletionDecision): Promise<void> { this.decisions.set(decision.id, decision) }
  async getDecision(decisionId: string): Promise<CompletionDecision | undefined> { return this.decisions.get(decisionId) }
  async getLatestDecisionByRun(taskRunId: string): Promise<CompletionDecision | undefined> {
    const runDecisions = Array.from(this.decisions.values()).filter((d) => d.taskRunId === taskRunId)
    return runDecisions.length > 0 ? runDecisions[runDecisions.length - 1] : undefined
  }
  async listDecisionsByRun(taskRunId: string): Promise<CompletionDecision[]> {
    return Array.from(this.decisions.values()).filter((d) => d.taskRunId === taskRunId)
  }
  clear(): void { this.evaluations.clear(); this.decisions.clear() }
}
