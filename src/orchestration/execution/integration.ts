import { execFileSync } from "node:child_process"
import { relative, resolve } from "node:path"
import type { ExecutionWorkstream } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import type { GitWorktreeManager } from "./worktree-manager"

export class ControlledIntegrationService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly worktrees: GitWorktreeManager, private readonly root: string) {}
  integrate(workstream: ExecutionWorkstream, sourceSha: string, branch: string, workspace: string): void {
    if (workstream.status !== "succeeded" && workstream.status !== "integration_pending") throw new Error("INTEGRATION_STATUS_INVALID")
    if (this.repository.hasIntegrated(workstream.workstreamId)) throw new Error("INTEGRATION_ALREADY_COMPLETE")
    const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.root, encoding: "utf8" }).trim()
    if (current !== sourceSha) throw new Error("INTEGRATION_BASE_DRIFT")
    const names = execFileSync("git", ["diff", "--name-only", `${sourceSha}..${branch}`], { cwd: this.root, encoding: "utf8" }).split("\n").map(s => s.trim()).filter(Boolean)
    for (const name of names) { const normalized = name.replaceAll("\\", "/"); if (!workstream.ownedPaths.some(owner => normalized === owner || normalized.startsWith(`${owner.replace(/\/$/, "")}/`))) throw new Error(`OWNERSHIP_VIOLATION:${normalized}`); this.worktrees.assertOwnedPath(workspace, normalized) }
    const attemptId = `integration-${workstream.workstreamId}-${Date.now()}`
    this.repository.recordIntegration({ attemptId, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "started", verification: {}, evidence: {}, createdAt: new Date().toISOString() })
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: this.root, stdio: "pipe" })
      this.repository.recordIntegration({ attemptId: `${attemptId}-complete`, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "integrated", verification: { clean: true }, evidence: { changedFiles: names }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() })
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integration_pending")
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integrated")
    } catch (error) { try { execFileSync("git", ["merge", "--abort"], { cwd: this.root, stdio: "pipe" }) } catch {} ; throw error }
  }
}
