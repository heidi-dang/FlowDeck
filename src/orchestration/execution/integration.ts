import { execFileSync } from "node:child_process"
import { relative, resolve } from "node:path"
import type { ExecutionWorkstream } from "./contracts"
import { ownershipClaimMatchesPath } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import type { GitWorktreeManager } from "./worktree-manager"
import type { SqlitePerformanceRepository } from "../performance/sqlite-repository"

function normalizePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "") }
export function pathOwnedBy(path: string, owner: string): boolean {
  const candidate = normalizePath(path)
  return ownershipClaimMatchesPath(candidate, normalizePath(owner))
}

export class ControlledIntegrationService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly worktrees: GitWorktreeManager, private readonly root: string, private readonly performance?: SqlitePerformanceRepository) {}
  currentSourceSha(): string { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.root, encoding: "utf8" }).trim() }
  integrate(workstream: ExecutionWorkstream, sourceSha: string, branch: string, workspace: string): void {
    if (workstream.status !== "succeeded" && workstream.status !== "integration_pending") throw new Error("INTEGRATION_STATUS_INVALID")
    if (this.repository.hasIntegrated(workstream.workstreamId)) throw new Error("INTEGRATION_ALREADY_COMPLETE")
    const current = this.currentSourceSha()
    if (current !== sourceSha) throw new Error("INTEGRATION_BASE_DRIFT")
    const branchBase = execFileSync("git", ["merge-base", sourceSha, branch], { cwd: this.root, encoding: "utf8" }).trim()
    const names = execFileSync("git", ["diff", "--name-only", `${branchBase}..${branch}`], { cwd: this.root, encoding: "utf8" }).split("\n").map(s => s.trim()).filter(Boolean)
    for (const name of names) { const normalized = normalizePath(name); if (!workstream.ownedPaths.some(owner => pathOwnedBy(normalized, owner))) throw new Error(`OWNERSHIP_VIOLATION:${normalized}`); this.worktrees.assertOwnedPath(workspace, normalized) }
    const attemptId = `integration-${workstream.workstreamId}-${Date.now()}`
    this.repository.recordIntegration({ attemptId, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "started", verification: {}, evidence: {}, createdAt: new Date().toISOString() })
    const started = Date.now()
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: this.root, stdio: "pipe" })
      this.repository.recordIntegration({ attemptId: `${attemptId}-complete`, planId: workstream.planId, workstreamId: workstream.workstreamId, sourceSha, branch, status: "integrated", verification: { clean: true }, evidence: { changedFiles: names }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() })
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integration_pending")
      this.repository.transitionWorkstream(workstream.planId, workstream.workstreamId, "integrated")
      this.performance?.recordIntegratedWorkstream(workstream, true, Date.now() - started)
    } catch (error) { try { execFileSync("git", ["merge", "--abort"], { cwd: this.root, stdio: "pipe" }) } catch {} ; throw error }
  }
}
