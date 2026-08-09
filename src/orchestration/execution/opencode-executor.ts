import { execFileSync } from "node:child_process"
import type { AssignmentContextResult } from "../../services/context-scoping"
import type { ExecutionWorkstream } from "./contracts"
import type { IsolatedExecutionResult, IsolatedWorkstreamExecutor } from "./worktree-executor"
import type { WorktreeAllocation } from "./worktree-manager"
import type { StallObservation, WorkstreamBudgetHandle } from "../../services/adaptive-execution-control"
import { BUDGET_PROFILES } from "../../config/token-budget-config"

interface OpenCodeSessionNamespace {
  create?: (input: unknown) => Promise<unknown>
  prompt?: (input: unknown) => Promise<unknown>
  abort?: (input: unknown) => Promise<unknown>
}

interface OpenCodeClientShape { session?: OpenCodeSessionNamespace }

function responseData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  const data = (value as Record<string, unknown>).data
  return data && typeof data === "object" ? data as Record<string, unknown> : null
}

function responseUsage(value: unknown): { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  const data = responseData(value)
  const info = data?.info && typeof data.info === "object" ? data.info as Record<string, unknown> : data
  const tokens = info?.tokens && typeof info.tokens === "object" ? info.tokens as Record<string, unknown> : undefined
  if (!tokens) return undefined
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache as Record<string, unknown> : undefined
  return {
    input: typeof tokens.input === "number" ? tokens.input : undefined,
    output: typeof tokens.output === "number" ? tokens.output : undefined,
    reasoning: typeof tokens.reasoning === "number" ? tokens.reasoning : undefined,
    cacheRead: typeof cache?.read === "number" ? cache.read : undefined,
    cacheWrite: typeof cache?.write === "number" ? cache.write : undefined,
  }
}

function responseProgress(value: unknown): StallObservation | undefined {
  const data = responseData(value)
  const raw = data?.flowdeckProgress ?? data?.progress
  if (!raw || typeof raw !== "object") return undefined
  const candidate = raw as Record<string, unknown>
  const numeric = (key: keyof StallObservation): number => typeof candidate[key] === "number" && Number.isFinite(candidate[key]) ? Math.max(0, Math.floor(candidate[key] as number)) : 0
  return { repeatedFailure: numeric("repeatedFailure"), repeatedTool: numeric("repeatedTool"), unchangedDiff: numeric("unchangedDiff"), repeatedContext: numeric("repeatedContext"), evidenceDelta: numeric("evidenceDelta"), tokensSinceProgress: numeric("tokensSinceProgress") }
}

/**
 * Explicit enforce-mode adapter. It only supplies the existing OpenCode
 * session/prompt API; worktree allocation, budget authority and integration
 * remain owned by WorktreeExecutionService.
 */
export class OpenCodeWorkstreamExecutor implements IsolatedWorkstreamExecutor {
  constructor(private readonly client: unknown, private readonly verify: (allocation: WorktreeAllocation) => Promise<boolean> | boolean = OpenCodeWorkstreamExecutor.verifyGitState) {}

  async execute(workstream: ExecutionWorkstream, allocation: WorktreeAllocation, budget?: WorkstreamBudgetHandle, context?: AssignmentContextResult): Promise<IsolatedExecutionResult> {
    const session = (this.client as OpenCodeClientShape | null)?.session
    if (!session?.create || !session.prompt) throw new Error("OPENCODE_WORKSTREAM_API_UNAVAILABLE")
    const created = await session.create({ body: { title: `FlowDeck workstream: ${workstream.workstreamId}`, agent: workstream.resolvedAgent, metadata: { flowdeckWorkstreamId: workstream.workstreamId, flowdeckPlanId: workstream.planId } }, query: { directory: allocation.workspace } })
    const sessionData = responseData(created)
    const sessionId = typeof sessionData?.id === "string" ? sessionData.id : undefined
    if (!sessionId) throw new Error("OPENCODE_WORKSTREAM_SESSION_INVALID")
    const prompt = context?.prompt ?? `Execute the isolated workstream objective: ${workstream.objective}`
    const reservation = budget ? await budget.reserve({ requestId: `workstream:${workstream.runId}:${workstream.workstreamId}`, estimatedInputTokens: context?.estimatedTokens ?? 0, maxOutputTokens: BUDGET_PROFILES[workstream.budgetProfile].childTotal }) : undefined
    if (reservation && !reservation.allowed) {
      await budget?.terminate("budget_exhausted")
      return { status: "failed", verificationPassed: false, integrationPassed: false, durationMs: 0, terminationReason: "budget_exhausted", usefulnessSignals: ["budget_gate"] }
    }
    let prompted: unknown
    try {
      prompted = await session.prompt({ path: { id: sessionId }, query: { directory: allocation.workspace }, body: { agent: workstream.resolvedAgent, parts: [{ type: "text", text: prompt }], system: prompt } })
    } catch (error) {
      await budget?.terminate("policy_violation")
      try { await session.abort?.({ path: { id: sessionId }, query: { directory: allocation.workspace } }) } catch { /* cancellation remains authoritative in the budget controller */ }
      throw error
    }
    if (!responseData(prompted) && !(prompted && typeof prompted === "object")) {
      await budget?.terminate("policy_violation")
      throw new Error("OPENCODE_WORKSTREAM_PROMPT_FAILED")
    }
    const progress = responseProgress(prompted)
    if (budget && progress) {
      const stall = await budget.observe(progress)
      if (stall.stalled) {
        try { await session.abort?.({ path: { id: sessionId }, query: { directory: allocation.workspace } }) } catch { /* best effort after authoritative cancellation */ }
        return { status: "failed", verificationPassed: false, integrationPassed: false, reservationId: reservation?.reservationId, tokenReserved: reservation?.claimed, durationMs: 0, terminationReason: "no_progress", usefulnessSignals: ["stall_detection", ...stall.reasons] }
      }
    }
    let tokenUsed: number | undefined
    if (budget && reservation) {
      const usage = responseUsage(prompted) ?? { input: context?.estimatedTokens ?? 0, output: Math.max(0, reservation.claimed - (context?.estimatedTokens ?? 0)) }
      tokenUsed = Object.values(usage).reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0)
      await budget.reconcile({ reservationId: reservation.reservationId, requestId: `workstream:${workstream.runId}:${workstream.workstreamId}`, messageId: `message:${sessionId}`, usage, reason: "workstream_completed" })
    }
    const verificationPassed = await this.verify(allocation)
    return { status: verificationPassed ? "succeeded" : "failed", verificationPassed, integrationPassed: false, reservationId: reservation?.reservationId, tokenReserved: reservation?.claimed, tokenUsed, durationMs: 0, usefulnessSignals: ["opencode_session", "scoped_context", ...(verificationPassed ? ["git_diff_check"] : [])], terminationReason: verificationPassed ? "awaiting_integration" : "verification_failed" }
  }

  private static verifyGitState(allocation: WorktreeAllocation): boolean {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: allocation.workspace, encoding: "utf8" }).trim()
      if (head === allocation.sourceSha) return false
      execFileSync("git", ["diff", "--check", `${allocation.sourceSha}..HEAD`], { cwd: allocation.workspace, stdio: "pipe" })
      execFileSync("git", ["diff", "--cached", "--check"], { cwd: allocation.workspace, stdio: "pipe" })
      execFileSync("git", ["diff", "--check"], { cwd: allocation.workspace, stdio: "pipe" })
      return true
    } catch {
      return false
    }
  }
}
