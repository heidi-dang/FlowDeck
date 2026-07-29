/**
 * Completion repository port.
 *
 * Defines persistence boundaries for the completion sub-domain.
 * Will be connected to Dev 1's persistence layer after integration.
 */

import type { CompletionEvaluation } from "../domain/evaluation"

export interface CompletionRepository {
  /** Saves a completion evaluation result. */
  saveEvaluation(evaluation: CompletionEvaluation): Promise<void>

  /** Gets the latest completion evaluation for a contract version. */
  getLatestEvaluation(contractVersionId: string): Promise<CompletionEvaluation | undefined>

  /** Lists all evaluations for a contract version. */
  listEvaluations(contractVersionId: string): Promise<CompletionEvaluation[]>
}
