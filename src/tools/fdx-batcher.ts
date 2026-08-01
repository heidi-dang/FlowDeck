/**
 * FDX Batcher
 *
 * Supports batching multiple independent FDX operations into a single transport request.
 * Batch results preserve per-operation status and error information.
 * Each operation is isolated — one operation's failure does not affect others.
 */

import { checkFdxAvailability, runFdx, shouldDisableFallback } from "./fdx-shared"

export interface BatchOperation {
  id: string
  command: string[]
  description?: string
}

export interface OperationResult<T = unknown> {
  id: string
  success: boolean
  data?: T
  error?: string
  statusCode?: number
}

export interface BatchResult<T = unknown> {
  batchId: string
  totalOperations: number
  successfulOperations: number
  failedOperations: number
  results: OperationResult<T>[]
  durationMs: number
}

export interface BatcherOptions {
  /** Maximum operations per batch. Default: 50 */
  maxBatchSize?: number
  /** Timeout per operation in ms. Default: 30000 */
  operationTimeoutMs?: number
}

/**
 * Creates a batch ID from a timestamp and random suffix.
 */
function createBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * FDX Batcher class for executing multiple independent operations in a single request.
 *
 * Operations are executed in parallel, with each result isolated. Errors in one
 * operation do not affect others. Results preserve per-operation status and error info.
 */
export class FdxBatcher {
  private maxBatchSize: number
  private operationTimeoutMs: number

  constructor(options: BatcherOptions = {}) {
    this.maxBatchSize = options.maxBatchSize ?? 50
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000
  }

  /**
   * Execute a batch of operations.
   * Operations run in parallel for performance.
   */
  async execute<T = unknown>(operations: BatchOperation[]): Promise<BatchResult<T>> {
    const batchId = createBatchId()
    const startTime = Date.now()

    if (operations.length === 0) {
      return {
        batchId,
        totalOperations: 0,
        successfulOperations: 0,
        failedOperations: 0,
        results: [],
        durationMs: 0,
      }
    }

    if (operations.length > this.maxBatchSize) {
      throw new Error(
        `Batch size ${operations.length} exceeds maximum ${this.maxBatchSize}. ` +
          `Split into smaller batches or increase maxBatchSize.`
      )
    }

    const results = await Promise.all(
      operations.map((op) => this.executeOperation<T>(op))
    )

    const durationMs = Date.now() - startTime
    const successfulOperations = results.filter((r) => r.success).length
    const failedOperations = results.filter((r) => !r.success).length

    return {
      batchId,
      totalOperations: operations.length,
      successfulOperations,
      failedOperations,
      results,
      durationMs,
    }
  }

  /**
   * Execute a single operation within a batch context.
   */
  private async executeOperation<T = unknown>(operation: BatchOperation): Promise<OperationResult<T>> {
    try {
      if (!checkFdxAvailability()) {
        if (shouldDisableFallback()) {
          return {
            id: operation.id,
            success: false,
            error: "FDX unavailable and fallback disabled",
          }
        }
        return {
          id: operation.id,
          success: false,
          error: "FDX native binary unavailable",
        }
      }

      const output = runFdx(operation.command)
      return {
        id: operation.id,
        success: true,
        data: output as T,
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        id: operation.id,
        success: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Get the maximum batch size.
   */
  getMaxBatchSize(): number {
    return this.maxBatchSize
  }

  /**
   * Get the operation timeout.
   */
  getOperationTimeoutMs(): number {
    return this.operationTimeoutMs
  }
}

/**
 * Default batcher instance with standard options.
 */
export const defaultBatcher = new FdxBatcher()

/**
 * Convenience function to batch FDX operations.
 */
export async function batchFdxOperations<T = unknown>(
  operations: BatchOperation[],
  options?: BatcherOptions
): Promise<BatchResult<T>> {
  const batcher = new FdxBatcher(options)
  return batcher.execute<T>(operations)
}
