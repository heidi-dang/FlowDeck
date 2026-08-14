import { describe, it, expect } from "vitest"
import { OrchestrationMetrics } from "../../src/orchestration/metrics"

describe("Orchestration Metrics Export (Phase 9 & 11 Hardening)", () => {
  it("records metrics and outputs valid Prometheus format", () => {
    const metrics = new OrchestrationMetrics()

    metrics.commandsDispatched.inc(5)
    metrics.commandsSucceeded.inc(4)
    metrics.commandsFailed.inc(1)
    metrics.activeRuns.set(2)
    metrics.queryLatency.observe(15)
    metrics.queryLatency.observe(25)

    const promText = metrics.toPrometheusText()
    expect(promText).toContain("# HELP commands_dispatched")
    expect(promText).toContain("# TYPE commands_dispatched counter")
    expect(promText).toContain("commands_dispatched 5")

    expect(promText).toContain("# HELP active_runs")
    expect(promText).toContain("# TYPE active_runs gauge")
    expect(promText).toContain("active_runs 2")

    expect(promText).toContain("query_latency_ms_count 2")
    expect(promText).toContain("query_latency_ms_sum 40")
    expect(promText).toContain("query_latency_ms_avg 20")
  })

  it("records metrics and outputs valid OpenTelemetry format", () => {
    const metrics = new OrchestrationMetrics()

    metrics.eventsPublished.inc(10)
    metrics.eventsDelivered.inc(9)
    metrics.eventsFailed.inc(1)
    metrics.deadLetterCount.inc(1)

    const otel = metrics.toOpenTelemetry()
    expect(otel).toBeDefined()
    expect(otel.resourceMetrics).toBeDefined()
    const scopeMetrics = (otel as any).resourceMetrics[0].scopeMetrics[0].metrics
    expect(scopeMetrics.length).toBeGreaterThan(0)

    const publishedMetric = scopeMetrics.find((m: any) => m.name === "events_published")
    expect(publishedMetric).toBeDefined()
    expect(publishedMetric.sum.dataPoints[0].asInt).toBe(10)
  })

  it("resets metrics correctly", () => {
    const metrics = new OrchestrationMetrics()

    metrics.commandsDispatched.inc(10)
    metrics.commandsDispatched.reset()
    expect(metrics.commandsDispatched.get()).toBe(0)
    expect(metrics.snapshot().length).toBeGreaterThan(0)
  })
})
