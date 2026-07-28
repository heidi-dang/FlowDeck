/**
 * GitHub REST API client for PR Monitor.
 * Uses the installed `gh` CLI or falls back to raw fetch.
 */

import { execFileSync } from "child_process"

export class GitHubClient {
  token: string

  constructor(token?: string) {
    this.token = token ?? process.env.GITHUB_TOKEN ?? ""
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `https://api.github.com${path}`
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "flowdeck-pr-monitor",
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub API ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`)
    }
    return res.json() as Promise<T>
  }

  async getPr(repo: string, prNumber: number): Promise<PrResponse> {
    return this.request<PrResponse>("GET", `/repos/${repo}/pulls/${prNumber}`)
  }

  async listWorkflowJobs(runId: number): Promise<JobsResponse> {
    return this.request<JobsResponse>("GET", `/repos/${this.repo}/actions/runs/${runId}/jobs`)
  }

  async downloadJobLogs(jobId: number): Promise<string> {
    const url = `https://api.github.com/repos/${this.repo}/actions/jobs/${jobId}/logs`
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "flowdeck-pr-monitor",
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Log download failed: ${res.status}`)
    return res.text()
  }

  async rerunFailedJobs(runId: number): Promise<void> {
    await this.request("POST", `/repos/${this.repo}/actions/runs/${runId}/rerun-failed-jobs`)
  }

  async getPrDiff(repo: string, prNumber: number): Promise<string> {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3.diff",
      "User-Agent": "flowdeck-pr-monitor",
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Diff fetch failed: ${res.status}`)
    return res.text()
  }

  async listChangedFiles(repo: string, prNumber: number): Promise<string[]> {
    const files = await this.request<FileResponse[]>("GET", `/repos/${repo}/pulls/${prNumber}/files`)
    return files.map(f => f.filename)
  }

  async createCommit(repo: string, branch: string, message: string, treeSha: string, parentSha: string): Promise<string> {
    const { sha } = await this.request<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
      message,
      tree: treeSha,
      parents: [parentSha],
    })
    return sha
  }

  async updateRef(repo: string, branch: string, sha: string): Promise<void> {
    await this.request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha })
  }

  async addPrComment(repo: string, prNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body })
  }

  async getWorkflowRun(runId: number): Promise<WorkflowRunResponse> {
    return this.request<WorkflowRunResponse>("GET", `/repos/${this.repo}/actions/runs/${runId}`)
  }

  // ── Helpers ─────────────────────────────────────────────────

  private repo = ""

  setRepo(r: string): void { this.repo = r }
}

// ── Response types ──────────────────────────────────────────────────────

export interface PrResponse {
  number: number
  state: string
  head: { sha: string; ref: string; repo: { full_name: string; fork: boolean } }
  base: { repo: { full_name: string } }
  title: string
  body: string | null
  mergeable_state: string
}

export interface JobsResponse {
  total_count: number
  jobs: JobResponse[]
}

export interface JobResponse {
  id: number
  run_id: number
  run_attempt: number
  name: string
  status: string
  conclusion: string | null
  started_at: string
  completed_at: string
  steps: StepResponse[]
  runner_name?: string
  labels?: string[]
}

export interface StepResponse {
  name: string
  status: string
  conclusion: string | null
  number: number
}

export interface FileResponse {
  filename: string
  status: string
  additions: number
  deletions: number
}

export interface WorkflowRunResponse {
  id: number
  name: string
  head_branch: string
  head_sha: string
  status: string
  conclusion: string | null
  run_number: number
  run_attempt: number
  created_at: string
  updated_at: string
  jobs_url: string
  logs_url: string
}
