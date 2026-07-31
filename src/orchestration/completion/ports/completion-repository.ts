import type { CompletionEvaluation } from "../domain/evaluation"
import type { CompletionDecision } from "../decision/completion-decision"

export interface CompletionRepository {
  /** Saves a completion evaluation result. */
  saveEvaluation(evaluation: CompletionEvaluation): Promise<void>

  /** Gets the latest completion evaluation for a contract version. */
  getLatestEvaluation(contractVersionId: string): Promise<CompletionEvaluation | undefined>

  /** Lists all evaluations for a contract version. */
  listEvaluations(contractVersionId: string): Promise<CompletionEvaluation[]>

  /** Saves a completion decision. */
  saveDecision(decision: CompletionDecision): Promise<void>

  /** Gets a completion decision by ID. */
  getDecision(decisionId: string): Promise<CompletionDecision | undefined>

  /** Gets the latest decision for a task run. */
  getLatestDecisionByRun(taskRunId: string): Promise<CompletionDecision | undefined>

  /** Lists all decisions for a task run. */
  listDecisionsByRun(taskRunId: string): Promise<CompletionDecision[]>

  /** Supersede a previous decision by linking it to its replacement. */
  supersedeDecision(previousDecisionId: string, newDecisionId: string): Promise<void>
}
