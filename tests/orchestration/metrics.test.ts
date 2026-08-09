import { describe, it, expect, beforeEach } from "bun:test";
import { OrchestrationMetrics } from "../../src/orchestration/metrics";

describe("OrchestrationMetrics", () => {
  let metrics: OrchestrationMetrics;

  beforeEach(() => {
    metrics = new OrchestrationMetrics();
  });

  describe("Counters", () => {
    it("should initialize to 0", () => {
      expect(metrics.commandsDispatched.get()).toBe(0);
      expect(metrics.commandsSucceeded.get()).toBe(0);
      expect(metrics.commandsFailed.get()).toBe(0);
      expect(metrics.eventsPublished.get()).toBe(0);
      expect(metrics.eventsDelivered.get()).toBe(0);
      expect(metrics.eventsFailed.get()).toBe(0);
      expect(metrics.replaysStarted.get()).toBe(0);
      expect(metrics.replaysCompleted.get()).toBe(0);
      expect(metrics.runsCompleted.get()).toBe(0);
      expect(metrics.runsFailed.get()).toBe(0);
      expect(metrics.deadLetterCount.get()).toBe(0);
    });

    it("should increment counter by 1 by default", () => {
      metrics.commandsDispatched.inc();
      expect(metrics.commandsDispatched.get()).toBe(1);
    });

    it("should increment counter by specific value", () => {
      metrics.commandsDispatched.inc(5);
      expect(metrics.commandsDispatched.get()).toBe(5);
    });

    it("should reset counter to 0", () => {
      metrics.commandsDispatched.inc(10);
      expect(metrics.commandsDispatched.get()).toBe(10);
      metrics.commandsDispatched.reset();
      expect(metrics.commandsDispatched.get()).toBe(0);
    });
  });

  describe("Gauges", () => {
    it("should initialize to 0", () => {
      expect(metrics.activeRuns.get()).toBe(0);
      expect(metrics.subscriberLag.get()).toBe(0);
    });

    it("should set gauge value", () => {
      metrics.activeRuns.set(42);
      expect(metrics.activeRuns.get()).toBe(42);
    });

    it("should increment gauge by 1 by default", () => {
      metrics.activeRuns.set(10);
      metrics.activeRuns.inc();
      expect(metrics.activeRuns.get()).toBe(11);
    });

    it("should increment gauge by specific value", () => {
      metrics.activeRuns.set(10);
      metrics.activeRuns.inc(5);
      expect(metrics.activeRuns.get()).toBe(15);
    });

    it("should decrement gauge by 1 by default", () => {
      metrics.activeRuns.set(10);
      metrics.activeRuns.dec();
      expect(metrics.activeRuns.get()).toBe(9);
    });

    it("should decrement gauge by specific value", () => {
      metrics.activeRuns.set(10);
      metrics.activeRuns.dec(3);
      expect(metrics.activeRuns.get()).toBe(7);
    });
  });

  describe("Histograms", () => {
    it("should initialize empty stats", () => {
      const stats = metrics.queryLatency.get();
      expect(stats.count).toBe(0);
      expect(stats.sum).toBe(0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.avg).toBe(0);
    });

    it("should compute correct statistics", () => {
      metrics.queryLatency.observe(10);
      metrics.queryLatency.observe(20);
      metrics.queryLatency.observe(30);

      const stats = metrics.queryLatency.get();
      expect(stats.count).toBe(3);
      expect(stats.sum).toBe(60);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(30);
      expect(stats.avg).toBe(20);
    });
  });

  describe("snapshot()", () => {
    it("should snapshot all metrics including counter, gauge, and histogram statistics", () => {
      metrics.commandsDispatched.inc(3);
      metrics.activeRuns.set(5);
      metrics.queryLatency.observe(100);
      metrics.queryLatency.observe(200);

      const snap = metrics.snapshot();
      expect(snap.length).toBeGreaterThan(0);

      // Verify Counter in snapshot
      const dispatched = snap.find((m) => m.name === "commands_dispatched");
      expect(dispatched).toBeDefined();
      expect(dispatched!.value).toBe(3);
      expect(new Date(dispatched!.timestamp).getTime()).toBeGreaterThan(0);

      // Verify Gauge in snapshot
      const active = snap.find((m) => m.name === "active_runs");
      expect(active).toBeDefined();
      expect(active!.value).toBe(5);

      // Verify Histogram in snapshot
      const count = snap.find((m) => m.name === "query_latency_ms_count");
      const sum = snap.find((m) => m.name === "query_latency_ms_sum");
      const min = snap.find((m) => m.name === "query_latency_ms_min");
      const max = snap.find((m) => m.name === "query_latency_ms_max");
      const avg = snap.find((m) => m.name === "query_latency_ms_avg");

      expect(count).toBeDefined();
      expect(count!.value).toBe(2);

      expect(sum).toBeDefined();
      expect(sum!.value).toBe(300);

      expect(min).toBeDefined();
      expect(min!.value).toBe(100);

      expect(max).toBeDefined();
      expect(max!.value).toBe(200);

      expect(avg).toBeDefined();
      expect(avg!.value).toBe(150);
    });
  });

  describe("toPrometheusText()", () => {
    it("should generate valid Prometheus text format", () => {
      metrics.commandsDispatched.inc(2);
      metrics.activeRuns.set(4);
      metrics.queryLatency.observe(50);

      const text = metrics.toPrometheusText();

      // Check HELP and TYPE for Counter
      expect(text).toContain("# HELP commands_dispatched Number of commands dispatched");
      expect(text).toContain("# TYPE commands_dispatched counter");
      expect(text).toContain("commands_dispatched 2");

      // Check HELP and TYPE for Gauge
      expect(text).toContain("# HELP active_runs Number of active runs");
      expect(text).toContain("# TYPE active_runs gauge");
      expect(text).toContain("active_runs 4");

      // Check HELP and TYPE for Histogram statistics
      expect(text).toContain("# HELP query_latency_ms_count Query latency in milliseconds (count)");
      expect(text).toContain("# TYPE query_latency_ms_count counter");
      expect(text).toContain("query_latency_ms_count 1");

      expect(text).toContain("# HELP query_latency_ms_sum Query latency in milliseconds (sum)");
      expect(text).toContain("# TYPE query_latency_ms_sum gauge");
      expect(text).toContain("query_latency_ms_sum 50");
    });
  });

  describe("toOpenTelemetry()", () => {
    it("should generate standard OpenTelemetry OTLP JSON structure", () => {
      metrics.commandsDispatched.inc(10);
      metrics.activeRuns.set(2);
      metrics.queryLatency.observe(150);

      const otel = metrics.toOpenTelemetry();
      expect(otel).toHaveProperty("resourceMetrics");

      const resourceMetrics = (otel as any).resourceMetrics;
      expect(resourceMetrics).toBeInstanceOf(Array);
      expect(resourceMetrics.length).toBe(1);

      const scopeMetrics = resourceMetrics[0].scopeMetrics;
      expect(scopeMetrics).toBeInstanceOf(Array);
      expect(scopeMetrics.length).toBe(1);

      const metricsList = scopeMetrics[0].metrics;
      expect(metricsList).toBeInstanceOf(Array);

      // Verify Counter
      const counterMetric = metricsList.find((m: any) => m.name === "commands_dispatched");
      expect(counterMetric).toBeDefined();
      expect(counterMetric.sum.dataPoints[0].asInt).toBe(10);
      expect(counterMetric.sum.isMonotonic).toBe(true);

      // Verify Gauge
      const gaugeMetric = metricsList.find((m: any) => m.name === "active_runs");
      expect(gaugeMetric).toBeDefined();
      expect(gaugeMetric.gauge.dataPoints[0].asInt).toBe(2);

      // Verify Histogram
      const histogramMetric = metricsList.find((m: any) => m.name === "query_latency_ms");
      expect(histogramMetric).toBeDefined();
      expect(histogramMetric.histogram.dataPoints[0].count).toBe("1");
      expect(histogramMetric.histogram.dataPoints[0].sum).toBe(150);
      expect(histogramMetric.histogram.dataPoints[0].min).toBe(150);
      expect(histogramMetric.histogram.dataPoints[0].max).toBe(150);
    });
  });
});
