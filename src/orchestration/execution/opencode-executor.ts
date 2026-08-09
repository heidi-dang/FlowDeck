import { execFileSync } from "node:child_process"
import type { AssignmentContextResult } from "../../services/context-scoping"
import type { ExecutionWorkstream } from "./contracts"
import type { IsolatedExecutionResult, IsolatedWorkstreamExecutor } from "./worktree-executor"
import type { WorktreeAllocation } from "./worktree-manager"
import type { WorkstreamBudgetHandle } from "../../services/adaptive-execution-control"

interface OpenCodeSessionNamespace {
  create?: (input: unknown) => Promise<unknown>
  prompt?: (input: unknown) => Promise<unknown>
}

interface OpenCodeClientShape { session?: OpenCodeSessionNamespace }

function responseData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  const data = (value as Record<string, unknown>).data
  return data && typeof data === "object" ? data as Record<string, unknown> : null
}

/**
 * Explicit enforce-mode adapter. It only supplies the existing OpenCode
 * session/prompt API; worktree allocation, budget authority and integration
 * remain owned by WorktreeExecutionService.
 */
export class OpenCodeWorkstreamExecutor implements IsolatedWorkstreamExecutor {
  constructor(private readonly client: unknown, private readonly verify: (allocation: WorktreeAllocation) => Promise<boolean> | boolean = OpenCodeWorkstreamExecutor.verifyGitState) {}

  async execute(workstream: ExecutionWorkstream, allocation: WorktreeAllocation, _budget?: WorkstreamBudgetHandle, context?: AssignmentContextResult): Promise<IsolatedExecutionResult> {
    const session = (this.client as OpenCodeClientShape | null)?.session
    if (!session?.create || !session.prompt) throw new Error("OPENCODE_WORKSTREAM_API_UNAVAILABLE")
    const created = await session.create({ body: { title: `FlowDeck workstream: ${workstream.workstreamId}`, agent: workstream.resolvedAgent, metadata: { flowdeckWorkstreamId: workstream.workstreamId, flowdeckPlanId: workstream.planId } }, query: { directory: allocation.workspace } })
    const sessionData = responseData(created)
    const sessionId = typeof sessionData?.id === "string" ? sessionData.id : undefined
    if (!sessionId) throw new Error("OPENCODE_WORKSTREAM_SESSION_INVALID")
    const prompt = context?.prompt ?? `Execute the isolated workstream objective: ${workstream.objective}`
    const prompted = await session.prompt({ path: { id: sessionId }, query: { directory: allocation.workspace }, body: { agent: workstream.resolvedAgent, parts: [{ type: "text", text: prompt }], system: prompt } })
    if (!responseData(prompted) && !(prompted && typeof prompted === "object")) throw new Error("OPENCODE_WORKSTREAM_PROMPT_FAILED")
    const verificationPassed = await this.verify(allocation)
    return { status: verificationPassed ? "succeeded" : "failed", verificationPassed, integrationPassed: false, durationMs: 0, usefulnessSignals: ["opencode_session", "scoped_context", ...(verificationPassed ? ["git_diff_check"] : [])], terminationReason: verificationPassed ? "awaiting_integration" : "verification_failed" }
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
