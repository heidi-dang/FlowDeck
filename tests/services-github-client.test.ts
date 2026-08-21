import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { GitHubClient } from "../src/services/pr-monitor/github-client"

describe("GitHubClient Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch
  let client: GitHubClient

  beforeEach(() => {
    originalFetch = globalThis.fetch
    client = new GitHubClient("test-token-123")
    client.setRepo("test-owner/test-repo")
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("handles request success and bearer token header", async () => {
    let capturedUrl = ""
    let capturedHeaders: any = {}
    let capturedMethod = ""
    let capturedBody = ""

    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = url
      capturedHeaders = init.headers
      capturedMethod = init.method
      capturedBody = init.body
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 42, name: "test-run" }),
      } as any
    }) as any

    const res = await client.request<{ id: number; name: string }>("POST", "/custom/path", { hello: "world" })
    expect(capturedUrl).toBe("https://api.github.com/custom/path")
    expect(capturedMethod).toBe("POST")
    expect(capturedHeaders.Authorization).toBe("Bearer test-token-123")
    expect(capturedHeaders["User-Agent"]).toBe("flowdeck-pr-monitor")
    expect(capturedBody).toBe(JSON.stringify({ hello: "world" }))
    expect(res.id).toBe(42)
  })

  it("throws descriptive error when response is not ok", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 404,
        text: async () => "Not Found Resource",
      } as any
    }) as any

    await expect(client.request("GET", "/not-found")).rejects.toThrow("GitHub API 404 on GET /not-found: Not Found Resource")
  })

  it("invokes getPr", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain("/repos/test-owner/test-repo/pulls/123")
      return {
        ok: true,
        json: async () => ({ number: 123, title: "Fix bug", head: { sha: "abc" } }),
      } as any
    }) as any

    const pr = await client.getPr("test-owner/test-repo", 123)
    expect(pr.number).toBe(123)
  })

  it("invokes listWorkflowJobs", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain("/repos/test-owner/test-repo/actions/runs/999/jobs")
      return {
        ok: true,
        json: async () => ({ total_count: 1, jobs: [{ id: 100, name: "build" }] }),
      } as any
    }) as any

    const jobs = await client.listWorkflowJobs(999)
    expect(jobs.total_count).toBe(1)
  })

  it("invokes downloadJobLogs", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain("/repos/test-owner/test-repo/actions/jobs/100/logs")
      return {
        ok: true,
        text: async () => "Log output content",
      } as any
    }) as any

    const logs = await client.downloadJobLogs(100)
    expect(logs).toBe("Log output content")

    // Test failure case
    globalThis.fetch = (async () => ({ ok: false, status: 500 } as any)) as any
    await expect(client.downloadJobLogs(100)).rejects.toThrow("Log download failed: 500")
  })

  it("invokes rerunFailedJobs", async () => {
    let called = false
    globalThis.fetch = (async (url: string, init: any) => {
      expect(url).toContain("/repos/test-owner/test-repo/actions/runs/999/rerun-failed-jobs")
      expect(init.method).toBe("POST")
      called = true
      return { ok: true, json: async () => ({}) } as any
    }) as any

    await client.rerunFailedJobs(999)
    expect(called).toBe(true)
  })

  it("invokes getPrDiff", async () => {
    globalThis.fetch = (async (url: string, init: any) => {
      expect(url).toContain("/repos/test-owner/test-repo/pulls/123")
      expect(init.headers.Accept).toBe("application/vnd.github.v3.diff")
      return {
        ok: true,
        text: async () => "diff --git a/test.ts b/test.ts",
      } as any
    }) as any

    const diff = await client.getPrDiff("test-owner/test-repo", 123)
    expect(diff).toContain("diff --git")

    // Test failure case
    globalThis.fetch = (async () => ({ ok: false, status: 403 } as any)) as any
    await expect(client.getPrDiff("test-owner/test-repo", 123)).rejects.toThrow("Diff fetch failed: 403")
  })

  it("invokes listChangedFiles", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
      } as any
    }) as any

    const files = await client.listChangedFiles("test-owner/test-repo", 123)
    expect(files).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("invokes createCommit, updateRef, addPrComment, and getWorkflowRun", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/git/commits")) {
        return { ok: true, json: async () => ({ sha: "new-commit-sha" }) } as any
      }
      if (url.includes("/git/refs/heads/")) {
        return { ok: true, json: async () => ({}) } as any
      }
      if (url.includes("/issues/123/comments")) {
        return { ok: true, json: async () => ({ id: 55 }) } as any
      }
      if (url.includes("/actions/runs/888")) {
        return { ok: true, json: async () => ({ id: 888, status: "completed" }) } as any
      }
      return { ok: true, json: async () => ({}) } as any
    }) as any

    const sha = await client.createCommit("test-owner/test-repo", "feat", "msg", "tree", "parent")
    expect(sha).toBe("new-commit-sha")

    await client.updateRef("test-owner/test-repo", "feat", "new-commit-sha")
    await client.addPrComment("test-owner/test-repo", 123, "comment message")
    const wfRun = await client.getWorkflowRun(888)
    expect(wfRun.id).toBe(888)
  })
})
