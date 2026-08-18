/**
 * ReadBatchService — Parallel safe repository inspection.
 *
 * Executes arrays of independent read operations concurrently.
 * Enforces strict serialization for write operations.
 */

export type ReadOperation = {
  tool: string
  args: Record<string, unknown>
  label?: string
}

export type ReadResult = {
  tool: string
  label?: string
  result?: unknown
  error?: string
  durationMs: number
}

export type ReadBatchResult = {
  results: ReadResult[]
  parallelCount: number
  totalDurationMs: number
  anyErrors: boolean
}

/** Tools proven safe to execute concurrently. */
const SAFE_READ_TOOLS = new Set([
  "fdx-read", "fdx-grep", "fdx-search", "fdx-outline", "fdx-ls",
  "fdx-tree", "fdx-diff", "fdx-git", "fdx-impact", "fdx-context",
  "fdx-decisions", "fdx-batch", "fdx-validate", "repo-memory",
  "codebase-state", "codegraph", "load-rules", "list-rules",
  "review-lessons", "planning-state",
])

export function isSafeReadTool(tool: string): boolean {
  return SAFE_READ_TOOLS.has(tool)
}

export interface ReadBatchOptions {
  maxConcurrency?: number
  timeoutMs?: number
  maxOutputBytes?: number
}

export async function executeBatchReads(
  operations: ReadOperation[],
  executor: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  options: ReadBatchOptions = {},
): Promise<ReadBatchResult> {
  const maxConcurrency = options.maxConcurrency ?? 8
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxOutputBytes = options.maxOutputBytes ?? 64_000

  for (const op of operations) {
    if (!isSafeReadTool(op.tool)) {
      throw new Error(
        "ReadBatchService: tool '" + op.tool + "' is not in the safe-read whitelist. " +
        "Mutating operations must be serialized and cannot be batched."
      )
    }
  }

  const startTime = Date.now()
  const results: ReadResult[] = []

  for (let i = 0; i < operations.length; i += maxConcurrency) {
    const chunk = operations.slice(i, i + maxConcurrency)
    const chunkResults = await Promise.all(
      chunk.map(async (op): Promise<ReadResult> => {
        const opStart = Date.now()
        try {
          const raw = await Promise.race([
            executor(op.tool, op.args),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("ReadBatch timeout for " + op.tool)), timeoutMs)
            ),
          ])
          const serialized = typeof raw === "string" ? raw : JSON.stringify(raw)
          const truncated =
            Buffer.byteLength(serialized, "utf-8") > maxOutputBytes
              ? serialized.slice(0, maxOutputBytes) + "...[truncated]"
              : serialized
          return { tool: op.tool, label: op.label, result: truncated, durationMs: Date.now() - opStart }
        } catch (err) {
          return {
            tool: op.tool,
            label: op.label,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - opStart,
          }
        }
      })
    )
    results.push(...chunkResults)
  }

  return {
    results,
    parallelCount: operations.length,
    totalDurationMs: Date.now() - startTime,
    anyErrors: results.some(r => r.error != null),
  }
}

/** Format batch results into a compact context string. */
export function formatBatchResults(batch: ReadBatchResult): string {
  const lines: string[] = []
  for (const r of batch.results) {
    const label = r.label ?? r.tool
    if (r.error) {
      lines.push("[ERROR " + label + "]: " + r.error)
    } else {
      const content = typeof r.result === "string" ? r.result : JSON.stringify(r.result)
      lines.push("[READ " + label + " (" + r.durationMs + "ms)]:\n" + content)
    }
  }
  return lines.join("\n\n")
}
