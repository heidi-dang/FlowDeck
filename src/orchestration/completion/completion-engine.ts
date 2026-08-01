/**
 * Completion Engine
 *
 * Enforces the 6 semantic completion gates.
 * Ensures idempotent completion checks - calling checkCompletion multiple times
 * with the same input produces the same result.
 * Model report cannot bypass the completion engine.
 */

import { CompletionGate, GateResult, CompletionGateInput, ALL_GATES } from "./completion-gates"
import { AggregatedGateResult, evaluateAllGates, evaluateGate } from "./completion-evaluator"

export interface CompletionCheckResult {
  readonly canComplete: boolean;
  readonly evaluation: AggregatedGateResult;
  readonly blockedReasons: readonly string[];
}

export interface IdempotencyRecord {
  readonly runId: string;
  readonly inputHash: string;
  readonly result: CompletionCheckResult;
  readonly checkedAt: Date;
}

/**
 * Deep freeze helper for completion results.
 * Handles arrays, objects, Date, Map, and Set instances.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || obj === undefined) return obj as Readonly<T>
  if (typeof obj !== "object") return obj as Readonly<T>

  if (Array.isArray(obj)) {
    Object.freeze(obj)
    for (const item of obj) {
      deepFreeze(item)
    }
    return obj as Readonly<T>
  }

  if (obj instanceof Date) {
    Object.freeze(obj)
    return obj as Readonly<T>
  }

  if (obj instanceof Map) {
    Object.freeze(obj)
    for (const value of obj.values()) {
      deepFreeze(value)
    }
    return obj as Readonly<T>
  }

  if (obj instanceof Set) {
    Object.freeze(obj)
    for (const value of obj.values()) {
      deepFreeze(value)
    }
    return obj as Readonly<T>
  }

  Object.freeze(obj)
  for (const key of Object.keys(obj as object)) {
    deepFreeze((obj as Record<string, unknown>)[key])
  }
  return obj as Readonly<T>
}

/**
 * CompletionEngine enforces all 6 completion gates.
 *
 * Key properties:
 * - Idempotent: same input produces same output
 * - Deterministic: gate evaluation is deterministic
 * - Model report cannot bypass: no prose-only completion allowed
 */
export class CompletionEngine {
  private idempotencyCache: Map<string, IdempotencyRecord> = new Map()

  /**
   * Generates a hash key for the input to enable idempotency checking.
   * Uses deterministic ordering (sorted by id) so key order doesn't matter.
   */
  private hashInput(input: CompletionGateInput): string {
    const normalized = {
      runId: input.runId,
      currentSha: input.currentSha,
      assignmentsComplete: input.assignmentsComplete,
      verificationResults: input.verificationResults.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        status: r.status,
        targetSha: r.targetSha,
        required: r.required,
      })).sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      acceptanceCriteria: input.acceptanceCriteria.map((c) => ({
        id: c.id,
        priority: c.priority,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      requirements: input.requirements.map((r) => ({
        id: r.id,
        priority: r.priority,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      evidenceItems: input.evidenceItems.map((e) => ({
        id: e.id,
        sha: e.sha,
        runId: e.runId,
        status: e.status,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      requiredEvidence: (input.requiredEvidence ?? []).map((ev) => ({
        type: ev.type,
        description: ev.description,
        path: ev.path,
      })).sort((a, b) => (a.path ?? a.type).localeCompare(b.path ?? b.type)),
    }
    return JSON.stringify(normalized)
  }

  /**
   * Checks if a cached result exists for this input.
   */
  private getCachedResult(input: CompletionGateInput): IdempotencyRecord | undefined {
    const hash = this.hashInput(input)
    return this.idempotencyCache.get(`${input.runId}:${hash}`)
  }

  /**
   * Caches the result for idempotency.
   * The cached result is deeply frozen to prevent external mutation.
   */
  private cacheResult(input: CompletionGateInput, result: CompletionCheckResult): void {
    const hash = this.hashInput(input)
    const frozenResult = deepFreeze(result) as CompletionCheckResult
    const record: IdempotencyRecord = {
      runId: input.runId,
      inputHash: hash,
      result: frozenResult,
      checkedAt: new Date(),
    }
    this.idempotencyCache.set(`${input.runId}:${hash}`, record)
  }

  /**
   * Checks all completion gates for the given input.
   * This method is idempotent - calling it multiple times with the same input
   * returns the same cached result.
   *
   * Model report CANNOT bypass this engine. Only gate evaluation results matter.
   */
  checkCompletion(input: CompletionGateInput): CompletionCheckResult {
    const cached = this.getCachedResult(input)
    if (cached) {
      return cached.result
    }

    const evaluation = evaluateAllGates(input)

    const blockedReasons = evaluation.failingGates.flatMap((gate) =>
      gate.reasons ?? []
    )

    const result: CompletionCheckResult = {
      canComplete: evaluation.allPassed,
      evaluation,
      blockedReasons: Object.freeze([...blockedReasons]),
    }

    this.cacheResult(input, result)

    return result
  }

  /**
   * Forces a fresh evaluation, bypassing idempotency cache.
   * Use only for testing or when input has legitimately changed.
   */
  forceCheckCompletion(input: CompletionGateInput): CompletionCheckResult {
    const evaluation = evaluateAllGates(input)

    const blockedReasons = evaluation.failingGates.flatMap((gate) =>
      gate.reasons ?? []
    )

    return {
      canComplete: evaluation.allPassed,
      evaluation,
      blockedReasons: Object.freeze([...blockedReasons]),
    }
  }

  /**
   * Returns the result of a specific gate.
   * Useful for debugging individual gate failures.
   */
  checkGate(gate: CompletionGate, input: CompletionGateInput): GateResult {
    const cached = this.getCachedResult(input)
    if (cached) {
      const found = cached.result.evaluation.gateResults.find((g) => g.gate === gate)
      if (found) {
        return found
      }
    }

    return evaluateGate(gate, input)
  }

  /**
   * Clears the idempotency cache.
   * Use only for testing.
   */
  clearCache(): void {
    this.idempotencyCache.clear()
  }

  /**
   * Returns all gates that must pass for completion.
   */
  getRequiredGates(): readonly CompletionGate[] {
    return ALL_GATES
  }

  /**
   * Returns a summary of the completion check result.
   */
  static summarizeResult(result: CompletionCheckResult): string {
    const lines: string[] = []
    lines.push(`Completion: ${result.canComplete ? "ALLOWED" : "BLOCKED"}`)
    lines.push(`Gates passed: ${result.evaluation.passedCount}/${result.evaluation.totalCount}`)

    if (result.blockedReasons.length > 0) {
      lines.push("Blocked reasons:")
      for (const reason of result.blockedReasons) {
        lines.push(`  - ${reason}`)
      }
    }

    return lines.join("\n")
  }
}
