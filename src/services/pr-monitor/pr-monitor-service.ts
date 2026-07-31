/**
 * FDX PR Monitor Service — persistent background service for CI auto-repair.
 *
 * Lifecycle:
 *   1. start() — begins polling or webhook listening
 *   2. On failure — collects logs, classifies, repairs, validates, pushes
 *   3. stop() — gracefully shuts down
 */

import { logWrite } from "../../lib/logger"
import { GitHubClient } from "./github-client"
import { GitHubWebhookServer } from "./github-webhook-server"
import { RepairOrchestrator } from "./repair-orchestrator"
import { RepairStateStore, createDefaultStateStore } from "./repair-state-store"
import { RepairLock } from "./repair-lock"
import type {
  MonitorStatus,
  PrMonitorConfig,
  PrMonitorMode,
  PrMonitorToolResponse,
} from "./types"
import { DEFAULT_PR_MONITOR_CONFIG } from "./types"

export class PrMonitorService {
  private running = false
  private config: PrMonitorConfig
  private store: RepairStateStore
  private lock = new RepairLock()
  private client = new GitHubClient()
  private orchestrator: RepairOrchestrator
  private webhookServer = new GitHubWebhookServer()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private repo = ""
  private pr = 0

  constructor(config?: Partial<PrMonitorConfig>) {
    this.config = { ...DEFAULT_PR_MONITOR_CONFIG, ...config }
    this.store = createDefaultStateStore()
    this.orchestrator = new RepairOrchestrator(this.client, this.store, this.lock, {
      maxAttempts: this.config.max_attempts_per_head_sha,
      retryFlakyOnce: this.config.retry_flaky_once,
    })
  }

  async start(repo: string, pr: number, mode?: PrMonitorMode): Promise<PrMonitorToolResponse> {
    if (this.running) {
      return { ok: false, action: "start", message: "Monitor already running" }
    }
    this.repo = repo
    this.pr = pr
    this.running = true

    if (mode) this.config.mode = mode
    this.client.setRepo(repo)

    // Start webhook server
    if (this.config.event_source === "github_app") {
      this.webhookServer.onEvent(async (payload) => {
        if (payload.event === "workflow_job") {
          await this.handleWorkflowJobEvent(payload.body as any)
        }
      })
      try {
        const port = await this.webhookServer.start()
        try {
          logWrite(process.cwd(), "info", "pr-monitor", `webhook server listening on port ${port}`)
        } catch {
          // Logger failure must never fail service startup
        }
      } catch (err) {
        return { ok: false, action: "start", message: `Webhook server failed: ${err}` }
      }
    }

    // Start polling fallback
    if (this.config.event_source === "polling") {
      this.pollTimer = setInterval(() => this.poll(), 30_000)
    }

    return {
      ok: true,
      action: "start",
      message: `PR Monitor started for ${repo}#${pr} in ${this.config.mode} mode`,
    }
  }

  async stop(): Promise<PrMonitorToolResponse> {
    if (!this.running) {
      return { ok: false, action: "stop", message: "Monitor not running" }
    }
    this.running = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.webhookServer.stop()
    return { ok: true, action: "stop", message: "PR Monitor stopped" }
  }

  async status(): Promise<MonitorStatus> {
    return {
      running: this.running,
      repo: this.repo || undefined,
      pr: this.pr || undefined,
      mode: this.config.mode,
      active_repairs: this.lock.count(),
      config: this.config,
      recent_runs: this.store.recentRuns(10),
    }
  }

  async runOnce(repo: string, pr: number): Promise<PrMonitorToolResponse> {
    try {
      const prData = await this.client.getPr(repo, pr)
      if (prData.state !== "open") {
        return { ok: false, action: "run_once", message: "PR is not open" }
      }
      await this.pollWorkflowRun(repo, pr, prData.head.sha)
      return { ok: true, action: "run_once", message: `Checked ${repo}#${pr} — head: ${prData.head.sha.slice(0, 12)}` }
    } catch (err) {
      return { ok: false, action: "run_once", message: `Error: ${err}` }
    }
  }

  async repairNow(repo: string, pr: number, jobId?: number): Promise<PrMonitorToolResponse> {
    try {
      const prData = await this.client.getPr(repo, pr)
      if (prData.state !== "open") {
        return { ok: false, action: "repair_now", message: "PR is not open" }
      }

      // Find the failed job
      const workflows = await this.client.request<any>("GET", `/repos/${repo}/actions/runs?branch=${prData.head.ref}&per_page=5`)
      const run = workflows.workflow_runs?.[0]
      if (!run) {
        return { ok: false, action: "repair_now", message: "No workflow runs found" }
      }

      const jobs = await this.client.listWorkflowJobs(run.id)
      const failedJobs = jobId
        ? jobs.jobs.filter(j => j.id === jobId)
        : jobs.jobs.filter(j => j.conclusion === "failure")

      if (failedJobs.length === 0) {
        return { ok: false, action: "repair_now", message: "No failed jobs found" }
      }

      for (const job of failedJobs) {
        await this.orchestrator.handleJobFailure(repo, pr, prData.head.sha, job, prData)
      }

      return { ok: true, action: "repair_now", message: `Repaired ${failedJobs.length} failed job(s)` }
    } catch (err) {
      return { ok: false, action: "repair_now", message: `Error: ${err}` }
    }
  }

  private async handleWorkflowJobEvent(body: any): Promise<void> {
    if (!this.running) return
    const job = body?.workflow_job
    if (!job) return

    const conclusion = job.conclusion
    if (!conclusion || ["success", "neutral", "skipped", "cancelled", "stale"].includes(conclusion)) return

    const repo = body?.repository?.full_name
    const prNumber = job?.pull_requests?.[0]?.number
    const headSha = job?.head_sha

    if (!repo || !prNumber || !headSha) return

    // Fetch PR
    let prData: any
    try {
      prData = await this.client.getPr(repo, prNumber)
    } catch { return }

    await this.orchestrator.handleJobFailure(repo, prNumber, headSha, job, prData)
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.repo || !this.pr) return
    try {
      const prData = await this.client.getPr(this.repo, this.pr)
      await this.pollWorkflowRun(this.repo, this.pr, prData.head.sha)
    } catch { /* polling failed */ }
  }

  private async pollWorkflowRun(repo: string, pr: number, headSha: string): Promise<void> {
    // Check for failed jobs in recent workflow runs
    const runs = await this.client.request<any>("GET", `/repos/${repo}/actions/runs?head_sha=${headSha}&per_page=3`)
    for (const run of (runs.workflow_runs ?? [])) {
      if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "startup_failure" || run.conclusion === "action_required") {
        const jobs = await this.client.listWorkflowJobs(run.id)
        for (const job of jobs.jobs) {
          if (job.conclusion === "failure" && !this.lock.isLocked(repo, pr, headSha)) {
            const prData = await this.client.getPr(repo, pr)
            await this.orchestrator.handleJobFailure(repo, pr, headSha, job, prData)
          }
        }
      }
    }
  }

  dispose(): void {
    this.store.dispose()
  }
}
