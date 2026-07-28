import { afterAll, beforeAll, describe, expect, it } from "vitest"
import flowDeckPlugin, {
  cleanupSessionState,
  getSessionMetricsDiagnostics,
} from "../src/index"
import { buildHeidiCoordinatorPrompt } from "../src/agents/orchestrator"
import { evaluateDelegationJustification } from "../src/services/heidi-execution-policy"
import {
  launchStandaloneServer,
  type StandaloneServerMeta,
} from "../src/better-harness/testing/standalone-launcher"

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0
}

describe("orchestration performance baselines", () => {
  it("keeps routing deterministic, accurate, and sub-millisecond at p95", () => {
    const cases = [
      [{}, false],
      [{ explicitUserRequest: true }, true],
      [{ independentOwnership: true }, true],
      [{ specialistDomainRequired: true }, true],
      [{ auditOrSecurityReview: true }, false],
      [{ directDiscoveryFailed: true, multiDomainSpanning: true }, false],
    ] as const
    const latencies: number[] = []
    let correct = 0
    for (let iteration = 0; iteration < 500; iteration++) {
      for (const [input, expected] of cases) {
        const started = performance.now()
        const result = evaluateDelegationJustification(input)
        latencies.push(performance.now() - started)
        if (result.justified === expected) correct++
      }
    }
    expect(correct / (cases.length * 500)).toBe(1)
    expect(percentile(latencies, 0.95)).toBeLessThan(1)
  })

  it("keeps coordinator prompt token estimate and default tool-call count bounded", () => {
    const prompt = buildHeidiCoordinatorPrompt()
    const estimatedTokens = Math.ceil(prompt.length / 4)
    const defaultDecision = evaluateDelegationJustification({})
    const delegationToolCalls = defaultDecision.justified ? 1 : 0
    expect(estimatedTokens).toBeLessThan(5_000)
    expect(delegationToolCalls).toBe(0)
  })

  it("cleans state for concurrent sessions without cross-session residue", async () => {
    const plugin = await flowDeckPlugin.server({
      directory: process.cwd(),
      client: { app: { log: async () => {} } },
    } as never)
    const sessions = Array.from({ length: 25 }, (_, index) => `perf-session-${index}`)
    await Promise.all(sessions.map((sessionID) =>
      plugin.event?.({
        event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } },
      } as never),
    ))
    for (const sessionID of sessions) {
      cleanupSessionState(sessionID)
      expect(getSessionMetricsDiagnostics(sessionID)).toMatchObject({
        toolCalls: 0,
        retries: 0,
        delegations: 0,
        filesChangedCount: 0,
      })
    }
  })
})

describe("Better Harness HTTP/SSE performance baselines", () => {
  let meta: StandaloneServerMeta

  beforeAll(async () => {
    meta = await launchStandaloneServer(undefined, undefined, { heartbeatIntervalMs: 25 })
  })

  afterAll(async () => {
    await meta.shutdown()
  })

  it("keeps loopback health latency within p50/p95 baseline", async () => {
    const latencies: number[] = []
    for (let index = 0; index < 30; index++) {
      const started = performance.now()
      const response = await fetch(`${meta.baseUrl}/health`)
      expect(response.status).toBe(200)
      await response.text()
      latencies.push(performance.now() - started)
    }
    expect(percentile(latencies, 0.5)).toBeLessThan(25)
    expect(percentile(latencies, 0.95)).toBeLessThan(100)
  })
})
