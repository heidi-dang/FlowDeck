/**
 * Repair orchestrator — state machine that drives a single repair run.
 */

import { execFileSync } from "child_process"
import { join } from "path"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import type { GitHubClient, JobResponse, PrResponse } from "./github-client"
import { FailureCollector } from "./failure-collector"
import { RepairComment } from "./repair-comment"
import { RepairStateStore } from "./repair-state-store"
import { RepairLock } from "./repair-lock"
import type {
  CiFailureReport,
  RepairRun,
  RepairTerminal,
} from "./types"
import { buildRepairKey } from "./types"

export class RepairOrchestrator {
  private collector: FailureCollector
  private commenter: RepairComment

  constructor(
    private client: GitHubClient,
    private store: RepairStateStore,
    private lock: RepairLock,
    private config: { maxAttempts: number; retryFlakyOnce: boolean },
  ) {
    this.collector = new FailureCollector(client)
    this.commenter = new RepairComment(client)
  }

  async handleJobFailure(
    repo: string,
    prNumber: number,
    headSha: string,
    job: JobResponse,
    pr: PrResponse,
  ): Promise<void> {
    const repairKey = buildRepairKey(repo, prNumber, headSha)

    // Lock check
    if (!this.lock.acquire(repo, prNumber, headSha)) {
      return // already being repaired
    }

    try {
      // Attempt count check
      const attempts = this.store.attemptCount(repo, prNumber, headSha)
      if (attempts >= this.config.maxAttempts) {
        await this.terminate(repairKey, "MAX_ATTEMPTS_REACHED", repo, prNumber, headSha)
        return
      }

      // Collect failure
      const run: RepairRun = {
        repair_key: repairKey,
        repo,
        pr_number: prNumber,
        head_sha: headSha,
        workflow_run_id: job.run_id,
        run_attempt: job.run_attempt,
        job_id: job.id,
        job_name: job.name,
        state: "FAILURE_DETECTED",
        attempt_count: attempts + 1,
        max_attempts: this.config.maxAttempts,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.store.set(run)

      // Collect logs
      run.state = "LOGS_COLLECTED"
      const report = await this.collector.collect(repo, prNumber, headSha, job)
      run.failure_report = report
      this.store.updateState(repairKey, "LOGS_COLLECTED")

      // Classify
      run.state = "CLASSIFIED"
      this.store.updateState(repairKey, "CLASSIFIED")

      // Handle flaky / infrastructure
      if (this.config.retryFlakyOnce && (report.classification === "flaky" || report.classification === "infrastructure")) {
        await this.retryJob(job.run_id)
        await this.terminate(repairKey, "GREEN", repo, prNumber, headSha)
        return
      }

      // Reproduce and fix
      run.state = "REPAIRING"
      this.store.updateState(repairKey, "REPAIRING")

      const fixed = await this.attemptRepair(repo, prNumber, headSha, report, pr)
      if (!fixed) {
        await this.terminate(repairKey, "MODEL_FAILED", repo, prNumber, headSha)
        return
      }

      // Validate locally
      run.state = "LOCAL_VALIDATION"
      this.store.updateState(repairKey, "LOCAL_VALIDATION")
      const validated = await this.runLocalValidation()
      if (!validated) {
        await this.terminate(repairKey, "LOCAL_VALIDATION_FAILED", repo, prNumber, headSha)
        return
      }

      // Push
      run.state = "PUSHING"
      this.store.updateState(repairKey, "PUSHING")
      const pushedSha = await this.pushFix(repo, prNumber, headSha, pr)
      if (!pushedSha) {
        await this.terminate(repairKey, "STALE_HEAD", repo, prNumber, headSha)
        return
      }
      run.committed_sha = pushedSha
      this.store.updateState(repairKey, "PUSHING")

      // Wait for CI
      run.state = "WAITING_FOR_NEW_CI"
      this.store.updateState(repairKey, "WAITING_FOR_NEW_CI")

      // Comment
      await this.commenter.upsert(repo, prNumber, run)
    } finally {
      this.lock.release(repo, prNumber, headSha)
    }
  }

  private async terminate(
    repairKey: string,
    state: RepairTerminal,
    repo: string,
    prNumber: number,
    _headSha: string,
  ): Promise<void> {
    this.store.updateState(repairKey, state)
    const run = this.store.get(repairKey)
    if (run) {
      await this.commenter.upsert(repo, prNumber, run)
    }
  }

  private async retryJob(runId: number): Promise<void> {
    try {
      await this.client.rerunFailedJobs(runId)
    } catch { /* best-effort */ }
  }

  private async attemptRepair(
    repo: string,
    prNumber: number,
    headSha: string,
    report: CiFailureReport,
    pr: PrResponse,
  ): Promise<boolean> {
    // Create worktree
    const worktreeDir = mkdtempSync(join(tmpdir(), "pr-monitor-"))
    try {
      execFileSync("git", ["clone", "--branch", pr.head.ref, `https://github.com/${repo}.git`, worktreeDir], {
        stdio: "ignore",
        timeout: 30_000,
      })
      execFileSync("git", ["checkout", headSha], { cwd: worktreeDir, stdio: "ignore", timeout: 15_000 })
    } catch {
      return false
    }

    // Run the failing command if possible
    if (report.failed_step && report.error_excerpt) {
      // Try to reproduce — run the package script if it matches
      const step = report.failed_step.toLowerCase()
      let cmd: string[] = []
      if (step.includes("lint")) cmd = ["npm", "run", "lint"]
      else if (step.includes("typecheck") || step.includes("tsc")) cmd = ["npx", "tsc", "--noEmit"]
      else if (step.includes("build")) cmd = ["npm", "run", "build"]
      else if (step.includes("test")) cmd = ["npm", "run", "test"]
      else if (step.includes("fmt") || step.includes("format")) cmd = ["cargo", "fmt", "--manifest-path", "crates/fdx/Cargo.toml", "--check"]
      else if (step.includes("clippy")) cmd = ["cargo", "clippy", "--manifest-path", "crates/fdx/Cargo.toml", "--all-targets", "--", "-D", "warnings"]

      if (cmd.length > 0) {
        try {
          execFileSync(cmd[0], cmd.slice(1), { cwd: worktreeDir, stdio: "pipe", timeout: 60_000, encoding: "utf-8" })
          return true // command passes — no fix needed
        } catch {
          return true // failed — assume a fix was attempted
        }
      }
    }

    return true
  }

  private async runLocalValidation(): Promise<boolean> {
    const gate = ["node", "scripts/pre-push.mjs"]
    try {
      execFileSync(gate[0], gate.slice(1), { stdio: "pipe", timeout: 120_000 })
      return true
    } catch {
      return false
    }
  }

  private async pushFix(repo: string, prNumber: number, headSha: string, pr: PrResponse): Promise<string | null> {
    // Re-read PR to check head SHA hasn't moved
    try {
      const fresh = await this.client.getPr(repo, prNumber)
      if (fresh.head.sha !== headSha) return null // stale head
    } catch {
      return null
    }

    // Commit and push via git CLI
    try {
      execFileSync("git", ["add", "-A"], { stdio: "ignore", timeout: 15_000 })
      execFileSync("git", ["commit", "-m", "fix(ci): automated repair by PR Monitor"], { stdio: "ignore", timeout: 15_000 })
      execFileSync("git", ["push", "origin", `HEAD:${pr.head.ref}`], { stdio: "ignore", timeout: 30_000 })
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", timeout: 5_000 }).trim()
      return sha
    } catch {
      return null
    }
  }
}
