import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RepairOrchestrator } from "../src/services/pr-monitor/repair-orchestrator"
import { PrMonitorService } from "../src/services/pr-monitor/pr-monitor-service"
import { GitHubWebhookServer } from "../src/services/pr-monitor/github-webhook-server"
import { GitHubClient } from "../src/services/pr-monitor/github-client"
import { FailureCollector } from "../src/services/pr-monitor/failure-collector"
import { RepairStateStore } from "../src/services/pr-monitor/repair-state-store"
import { RepairComment } from "../src/services/pr-monitor/repair-comment"
import { RepairLock } from "../src/services/pr-monitor/repair-lock"
import { buildRepairKey } from "../src/services/pr-monitor/types"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

class MockGitHubClient extends GitHubClient {
  constructor() {
    super("test-token")
  }
  async request<T>(_method: string, path: string, _body?: unknown): Promise<T> {
    if (path.includes("/pulls/")) {
      return {
        number: 48,
        head: { sha: "sha123", ref: "fix/test" },
        base: { sha: "base123", ref: "main" },
        labels: [{ name: "auto-repair" }]
      } as any
    }
    if (path.includes("/comments")) {
      return { id: 999, body: "comment body" } as any
    }
    return {} as any
  }
  async downloadJobLogs(_jobId: number): Promise<string> {
    return "Error: FAIL tests/sample.test.ts\n  Expected 1 to be 2\n    at Object.<anonymous> (tests/sample.test.ts:15:5)"
  }
  async addPrComment(_repo: string, _prNumber: number, body: string): Promise<any> {
    return { id: 999, body }
  }
  async updatePrComment(_repo: string, commentId: number, body: string): Promise<any> {
    return { id: commentId, body }
  }
  async findPrComments(_repo: string, _prNumber: number): Promise<any[]> {
    return []
  }
}

describe("PR Monitor Deep Unit Tests", () => {
  let tempDir: string
  let store: RepairStateStore
  let lock: RepairLock
  let client: MockGitHubClient

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prmon-"))
    store = new RepairStateStore()
    lock = new RepairLock()
    client = new MockGitHubClient()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("buildRepairKey builds key correctly", () => {
    const key = buildRepairKey("owner/repo", 48, "sha123")
    expect(key).toBe("owner/repo:48:sha123")
  })

  it("RepairLock acquire and release", () => {
    expect(lock.acquire("repo", 1, "sha")).toBe(true)
    expect(lock.acquire("repo", 1, "sha")).toBe(false)
    lock.release("repo", 1, "sha")
    expect(lock.acquire("repo", 1, "sha")).toBe(true)
  })

  it("RepairStateStore persists and updates repair runs", () => {
    const key = buildRepairKey("owner/repo", 48, "sha123")
    store.set({
      repair_key: key,
      repo: "owner/repo",
      pr_number: 48,
      head_sha: "sha123",
      workflow_run_id: 101,
      run_attempt: 1,
      job_id: 1,
      job_name: "test",
      max_attempts: 3,
      attempt_count: 1,
      state: "REPAIRING",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    expect(store.attemptCount("owner/repo", 48, "sha123")).toBe(1)
    expect(store.get(key)).toBeDefined()

    store.updateState(key, "GREEN")
    expect(store.get(key)?.state).toBe("GREEN")
  })

  it("FailureCollector collects logs and parses failure details", async () => {
    const collector = new FailureCollector(client)
    const report = await collector.collect("owner/repo", 48, "sha123", {
      id: 101,
      run_id: 202,
      run_attempt: 1,
      name: "Unit Tests",
      conclusion: "failure",
      html_url: "https://github.com/test/job/101",
      steps: [{ name: "Test", conclusion: "failure" }]
    } as any)
    expect(report).toBeDefined()
    expect(report.job_name).toBe("Unit Tests")
    expect(report.error_excerpt).toContain("Expected 1 to be 2")
  })

  it("RepairComment posts and updates repair comments", async () => {
    const commenter = new RepairComment(client)
    await commenter.upsert("owner/repo", 48, {
      repair_key: "owner/repo:48:sha123",
      repo: "owner/repo",
      pr_number: 48,
      head_sha: "sha123",
      workflow_run_id: 101,
      run_attempt: 1,
      job_id: 1,
      job_name: "test",
      max_attempts: 3,
      attempt_count: 1,
      state: "REPAIRING",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  })

  it("RepairOrchestrator handles job failure state machine", async () => {
    const orchestrator = new RepairOrchestrator(
      client,
      store,
      lock,
      { maxAttempts: 2, retryFlakyOnce: true }
    )

    const job = {
      id: 101,
      run_id: 202,
      run_attempt: 1,
      name: "Unit Tests",
      conclusion: "failure",
      html_url: "https://github.com/test",
      steps: [{ name: "Test", conclusion: "failure" }]
    }
    const pr = {
      number: 48,
      head: { sha: "sha123", ref: "fix/test" },
      base: { sha: "base123", ref: "main" },
      labels: [{ name: "auto-repair" }]
    }

    await orchestrator.handleJobFailure("owner/repo", 48, "sha123", job as any, pr as any)
    expect(store.attemptCount("owner/repo", 48, "sha123")).toBeGreaterThan(0)
  })

  it("PrMonitorService lifecycle start, status, and stop", async () => {
    const service = new PrMonitorService()
    const startRes = await service.start("owner/repo", 48, "polling" as any)
    expect(startRes.ok).toBe(true)

    const statusRes = await service.status()
    expect(statusRes.running).toBe(true)

    const stopRes = await service.stop()
    expect(stopRes.ok).toBe(true)
  })

  it("GitHubWebhookServer handles payload parsing", async () => {
    const server = new GitHubWebhookServer()
    expect(server).toBeDefined()
  })
})
