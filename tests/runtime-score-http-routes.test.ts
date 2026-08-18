import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { routeRequestContext } from "../src/better-harness/transport/router"
import { getScoreboardFor, clearScoreboardFor } from "../src/services/runtime-score-stream"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Runtime Score HTTP & WebUI Router Endpoints", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "score-http-test-"))
    const scoreboard = getScoreboardFor(tmpDir)
    scoreboard.ingest({
      eventId: "ev-http-1",
      actionClass: "Shell",
      label: "npm test",
      sessionId: "s-http",
      score: 97,
      confidence: 0.95,
      evidenceCount: 2,
      currentHealth: 97,
      sessionIntegrity: 97,
      dimensions: { execution: 97 },
      reasons: [],
      at: Date.now(),
    })
  })

  afterEach(() => {
    clearScoreboardFor(tmpDir)
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  const mockCtx: any = {
    resolveProjectPath: (_serverKey: string, _projectKey: string) => tmpDir,
  }

  it("GET /better-harness/runtime-scores returns scores list and session health", async () => {
    const res = await routeRequestContext(mockCtx, "GET", "/api/v1/servers/default/projects/test-proj/better-harness/runtime-scores?sessionId=s-http", null)
    expect(res.status).toBe(200)
    const body: any = res.body
    expect(body.scores).toHaveLength(1)
    expect(body.scores[0].score).toBe(97)
    expect(body.scores[0].label).toBe("npm test")
    expect(body.sessionHealth.currentHealth).toBe(97)
  })

  it("GET /better-harness/session-health returns current health and session integrity", async () => {
    const res = await routeRequestContext(mockCtx, "GET", "/api/v1/servers/default/projects/test-proj/better-harness/session-health?sessionId=s-http", null)
    expect(res.status).toBe(200)
    const body: any = res.body
    expect(body.currentHealth).toBe(97)
    expect(body.sessionIntegrity).toBe(97)
  })

  it("GET /better-harness/runtime-scores/by-id/:eventId returns specific score event", async () => {
    const res = await routeRequestContext(mockCtx, "GET", "/api/v1/servers/default/projects/test-proj/better-harness/runtime-scores/by-id/ev-http-1", null)
    expect(res.status).toBe(200)
    const body: any = res.body
    expect(body.eventId).toBe("ev-http-1")
    expect(body.score).toBe(97)
  })

  it("GET /better-harness/ui/runtime-scores serves complete HTML dashboard with badges and accessibility markup", async () => {
    const res = await routeRequestContext(mockCtx, "GET", "/api/v1/servers/default/projects/test-proj/better-harness/ui/runtime-scores?sessionId=s-http", null)
    expect(res.status).toBe(200)
    const body: any = res.body
    expect(body.html).toContain("<!DOCTYPE html>")
    expect(body.html).toContain("FlowDeck 97%")
    expect(body.html).toContain("FlowDeck session health")
    expect(body.html).toContain("Current Health")
    expect(body.html).toContain("Session Integrity")
  })
})
