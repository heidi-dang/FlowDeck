/**
 * Machine-Readable Streaming Benchmark Runner
 * Measures event throughput, latency (p50, p95, max), memory footprint (baseline, peak, growth).
 */
import {
  StreamRepository,
  SequenceValidator,
  SequenceTracker,
  createStreamEvent,
} from '../../src/orchestration/streaming';

async function runBenchmark() {
  const sampleCount = 5000;
  const runId = `bench_run_${Date.now()}`;
  const repo = new StreamRepository(':memory:', { allowInMemory: true });
  const validator = new SequenceValidator();
  const tracker = new SequenceTracker(10000);

  const memBaseline = process.memoryUsage().heapUsed;
  const latencies: number[] = [];
  const startTotal = Date.now();

  for (let i = 1; i <= sampleCount; i++) {
    const t0 = performance.now();
    const isTerminal = i === sampleCount;

    const event = createStreamEvent({
      eventId: `evt_bench_${i}`,
      sequence: i,
      runId,
      type: isTerminal ? 'run.completed' : 'agent.progress',
      stage: isTerminal ? 'complete' : 'execute',
      importance: isTerminal ? 'critical' : 'normal',
      title: `Bench Event ${i}`,
      payload: { step: i, data: `val_${i}` },
    });

    // 1. Atomic Persistence & Sequence Allocation
    repo.persistEvent(runId, i, event.type, event.payload, Date.now());

    // 2. Sequence Validation
    const seqCheck = validator.validate(runId, i);
    if (!seqCheck.valid) {
      throw new Error(`Sequence validation failed at ${i}: ${seqCheck.error}`);
    }

    // 3. LRU Deduplication Tracking
    const tracked = tracker.track(event.eventId, i);
    if (!tracked) {
      throw new Error(`Duplicate detected unexpectedly at ${i}`);
    }

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
    benchmark: 'streaming-throughput-latency',
    timestamp: new Date().toISOString(),
    sampleCount,
    totalDurationMs: totalMs,
    opsPerSec: Math.round((sampleCount / totalMs) * 1000),
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

  console.log('=== Streaming Benchmark Results ===');
  console.log(JSON.stringify(report, null, 2));
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
