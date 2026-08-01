/**
 * Machine-Readable UI Projection Benchmark Runner
 * Measures state projection reduction rate, rendering time, and memory overhead.
 */
import { reduceRunStreamEvent, createStreamEvent, INITIAL_STATE } from '../../src/orchestration/streaming';

async function runUiBenchmark() {
  const sampleCount = 5000;
  const runId = `bench_ui_${Date.now()}`;
  let state = reduceRunStreamEvent(INITIAL_STATE, createStreamEvent({
    eventId: 'evt_init',
    sequence: 1,
    runId,
    type: 'run.created',
    stage: 'intake',
    importance: 'normal',
    title: 'Bench Run',
    payload: {},
  }));

  const memBaseline = process.memoryUsage().heapUsed;
  const latencies: number[] = [];
  const startTotal = Date.now();

  for (let i = 2; i <= sampleCount; i++) {
    const t0 = performance.now();
    const isTerminal = i === sampleCount;

    const event = createStreamEvent({
      eventId: `evt_ui_${i}`,
      sequence: i,
      runId,
      type: isTerminal ? 'run.completed' : (i % 5 === 0 ? 'agent.progress' : 'metrics.updated'),
      stage: isTerminal ? 'complete' : 'execute',
      importance: isTerminal ? 'critical' : 'normal',
      title: `Event ${i}`,
      payload: { elapsedMs: i * 10, inputTokens: i * 2, outputTokens: i },
    });

    state = reduceRunStreamEvent(state, event);

    const t1 = performance.now();
    latencies.push(t1 - t0);
  }

  const totalMs = Date.now() - startTotal;
  const memPeak = process.memoryUsage().heapUsed;

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const max = latencies[latencies.length - 1];

  const report = {
    benchmark: 'ui-projection-reduction',
    timestamp: new Date().toISOString(),
    sampleCount,
    totalDurationMs: totalMs,
    reductionsPerSec: Math.round((sampleCount / totalMs) * 1000),
    latencyMs: {
      median: Number(p50.toFixed(4)),
      p95: Number(p95.toFixed(4)),
      max: Number(max.toFixed(4)),
    },
    memoryBytes: {
      baseline: memBaseline,
      peak: memPeak,
      growthMb: Number(((memPeak - memBaseline) / (1024 * 1024)).toFixed(2)),
    },
  };

  console.log('=== UI Benchmark Results ===');
  console.log(JSON.stringify(report, null, 2));
}

runUiBenchmark().catch((err) => {
  console.error('UI Benchmark failed:', err);
  process.exit(1);
});
