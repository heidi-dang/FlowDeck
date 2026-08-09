import { execFileSync } from "node:child_process"
import type { ExecutionWorkstream } from "./contracts"
import { ownershipClaimMatchesPath } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import type { GitWorktreeManager } from "./worktree-manager"
import type { OrchestrationMetrics } from "../metrics"

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "") }
export function pathOwnedBy(path: string, owner: string): boolean {
  const candidate = normalizePath(path)
  return ownershipClaimMatchesPath(candidate, normalizePath(owner))
}

export class ControlledIntegrationService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly worktrees: GitWorktreeManager, private readonly root: string, private readonly metrics?: OrchestrationMetrics) {}
  currentSourceSha(): string { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.root, encoding: "utf8" }).trim() }
  /** Recover an integration that crossed the Git commit boundary before the
   * acknowledgement row was written. A branch already reachable from the
   * root is authoritative evidence of a completed merge; otherwise the
   * interrupted attempt is failed closed and can be retried explicitly. */
  recoverAfterRestart(): number {
    let repaired = 0
    for (const attempt of this.repository.listIntegrationAttempts("started")) {
      const plan = this.repository.getPlan(attempt.planId)
      const workstream = plan?.workstreams.find(item => item.workstreamId === attempt.workstreamId)
      if (!plan || !workstream || this.repository.hasIntegrated(attempt.workstreamId)) continue
      let merged = false
      try { execFileSync("git", ["merge-base", "--is-ancestor", attempt.branch, this.currentSourceSha()], { cwd: this.root, stdio: "pipe" }); merged = true } catch { /* branch was not merged */ }
      const now = new Date().toISOString()
      if (merged) {
        this.repository.recordIntegration({ attemptId: `${attempt.attemptId}-recovered`, planId: attempt.planId, workstreamId: attempt.workstreamId, sourceSha: attempt.sourceSha, branch: attempt.branch, status: "integrated", verification: { recovered: true }, evidence: { recoveredFrom: attempt.attemptId }, createdAt: now, completedAt: now })
        if (workstream.status === "succeeded") this.repository.transitionWorkstream(attempt.planId, attempt.workstreamId, "integration_pending")
        if (this.repository.getPlan(attempt.planId)?.workstreams.find(item => item.workstreamId === attempt.workstreamId)?.status === "integration_pending") this.repository.transitionWorkstream(attempt.planId, attempt.workstreamId, "integrated")
      } else {
        this.repository.recordIntegration({ attemptId: `${attempt.attemptId}-recovered-failed`, planId: attempt.planId, workstreamId: attempt.workstreamId, sourceSha: attempt.sourceSha, branch: attempt.branch, status: "failed", verification: {}, evidence: { recoveredFrom: attempt.attemptId }, error: "INTEGRATION_INTERRUPTED", createdAt: now, completedAt: now })
        if (workstream.status === "succeeded") { this.repository.transitionWorkstream(attempt.planId, attempt.workstreamId, "integration_pending"); this.repository.transitionWorkstream(attempt.planId, attempt.workstreamId, "failed", "INTEGRATION_INTERRUPTED") }
      }
      repaired += 1
    }
    return repaired
  }
  integrate(workstream: ExecutionWorkstream, sourceSha: string, branch: string, workspace: string): void {
    if (workstream.status !== "succeeded" && workstream.status !== "integration_pending") throw new Error("INTEGRATION_STATUS_INVALID")
    if (this.repository.hasIntegrated(workstream.workstreamId)) throw new Error("INTEGRATION_ALREADY_COMPLETE")
    const current = this.currentSourceSha()
    // The root may have advanced because another independent workstream was
    // integrated earlier in the same deterministic wave. That is expected.
    // It must still be a descendant of the allocation base; unrelated or
    // rewound root history is rejected as drift.
    try { execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, current], { cwd: this.root, stdio: "pipe" }) } catch { throw new Error("INTEGRATION_BASE_DRIFT") }
    try { execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, branch], { cwd: this.root, stdio: "pipe" }) } catch { throw new Error("INTEGRATION_BRANCH_BASE_MISMATCH") }
    const branchBase = execFileSync("git", ["merge-base", sourceSha, branch], { cwd: this.root, encoding: "utf8" }).trim()
    const names = execFileSync("git", ["diff", "--name-only", `${branchBase}..${branch}`], { cwd: this.root, encoding: "utf8" }).split("\n").map(s => s.trim()).filter(Boolean)
    for (const name of names) { const normalized = normalizePath(name); if (!workstream.ownedPaths.some(owner => pathOwnedBy(normalized, owner))) { this.metrics?.ownershipConflicts.inc(); throw new Error(`OWNERSHIP_VIOLATION:${normalized}`) }; try { this.worktrees.assertOwnedPath(workspace, normalized) } catch (error) { this.metrics?.ownershipConflicts.inc(); throw error } }
    const attemptId = `integration-${workstream.workstreamId}-${Date.now()}`
    this.repository.recordIntegration({ attemptId, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "started", verification: {}, evidence: {}, createdAt: new Date().toISOString() })
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: this.root, stdio: "pipe" })
      this.repository.recordIntegration({ attemptId: `${attemptId}-complete`, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "integrated", verification: { clean: true }, evidence: { changedFiles: names }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() })
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integration_pending")
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integrated")
    } catch (error) { try { execFileSync("git", ["merge", "--abort"], { cwd: this.root, stdio: "pipe" }) } catch {} ; try { this.repository.recordIntegration({ attemptId: `${attemptId}-failed`, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: String(error).includes("CONFLICT") ? "conflict" : "failed", verification: {}, evidence: { changedFiles: names }, error: error instanceof Error ? error.message : String(error), createdAt: new Date().toISOString(), completedAt: new Date().toISOString() }) } catch {} ; throw error }
  }
}
