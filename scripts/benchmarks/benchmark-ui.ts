/**
 * Machine-Readable UI Projection & DOM Rendering Benchmark Suite
 * Measures browser event-to-reducer processing rate, reducer-to-DOM rendering latency, and state projection overhead.
 */
import { reduceRunStreamEvent, createStreamEvent, INITIAL_STATE } from '../../src/orchestration/streaming';
import { Window } from 'happy-dom';
import { mountLiveDashboard } from '../../src/better-harness/ui/mount';
import { createHash } from 'crypto';

async function runUiBenchmark() {
  const sampleCount = 3000;
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

  // 1. Reducer Processing Benchmark
  const reducerLatencies: number[] = [];
  const startReducer = performance.now();

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
    reducerLatencies.push(t1 - t0);
  }

  const reducerDuration = performance.now() - startReducer;

  // 2. Reducer-to-DOM Render Benchmark using Happy-DOM
  const window = new Window();
  const document = window.document;
  const container = document.createElement('div');
  document.body.appendChild(container);

  const controller = mountLiveDashboard(container as any, {
    runId: 'bench-render-1',
    featureFlagEnabled: false,
  });

  const renderLatencies: number[] = [];
  const renderCount = 500;
  const startRender = performance.now();

  for (let i = 1; i <= renderCount; i++) {
    const t0 = performance.now();
    const event = createStreamEvent({
      eventId: `evt_render_${i}`,
      sequence: i + 10,
      runId: 'bench-render-1',
      type: 'agent.progress',
      stage: 'execute',
      importance: 'normal',
      title: `Render Step ${i}`,
      payload: { agentId: `agent_${i % 4}` },
    });

    controller.applyEvent(event);
    const t1 = performance.now();
    renderLatencies.push(t1 - t0);
  }

  const renderDuration = performance.now() - startRender;
  controller.destroy();

  const memPeak = process.memoryUsage().heapUsed;

  reducerLatencies.sort((a, b) => a - b);
  renderLatencies.sort((a, b) => a - b);

  const gitSha = require('child_process').execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const branch = require('child_process').execSync("git branch --show-current", { encoding: "utf-8" }).trim();

  const statusLines = require('child_process').execSync("git status --porcelain", { encoding: "utf-8" }).trim().split('\n').filter((line: string) => line && !line.includes('artifacts/'));
  const isDirty = statusLines.length > 0;
  if (isDirty) {
    console.error("FAIL: Cannot generate benchmark artifact from dirty working tree (uncommitted source code changes detected).");
    process.exit(1);
  }

  const report = {
    benchmarkSuite: 'ui-projection-dom-render',
    benchmarkType: 'microbenchmark-reducer-and-dom-render',
    timestamp: new Date().toISOString(),
    gitSha,
    dirty: false,
    branch,
    environment: process.env.NODE_ENV || 'test',
    systemInfo: {
      platform: process.platform,
      arch: process.arch,
      cpuCount: require('os').cpus().length,
      totalMemoryMb: Math.round(require('os').totalmem() / (1024 * 1024)),
    },
    runtimeVersions: {
      bun: Bun.version,
      node: process.version,
    },
    sampleCount,
    fixture: 'LiveDashboard UI Component',
    warmColdState: 'warm',
    metrics: {
      browserEventToReducer: {
        // Measurement type: in-process reducer microbenchmark (no real browser, no network)
        // Scope: reduceRunStreamEvent() pure function latency per call, in Node.js/Bun process
        measurementType: 'in-process-reducer-microbenchmark',
        samples: sampleCount,
        reductionsPerSec: Math.round((sampleCount / reducerDuration) * 1000),
        medianMs: Number(reducerLatencies[Math.floor(reducerLatencies.length * 0.5)].toFixed(4)),
        p95Ms: Number(reducerLatencies[Math.floor(reducerLatencies.length * 0.95)].toFixed(4)),
        maxMs: Number(reducerLatencies[reducerLatencies.length - 1].toFixed(4)),
      },
      reducerToDomRender: {
        // Measurement type: happy-dom render microbenchmark (JSDOM-like environment, NOT a real browser)
        // Scope: mountLiveDashboard().applyEvent() → happy-dom DOM mutation. Not real browser rendering.
        measurementType: 'happy-dom-render-microbenchmark',
        samples: renderCount,
        rendersPerSec: Math.round((renderCount / renderDuration) * 1000),
        medianMs: Number(renderLatencies[Math.floor(renderLatencies.length * 0.5)].toFixed(4)),
        p95Ms: Number(renderLatencies[Math.floor(renderLatencies.length * 0.95)].toFixed(4)),
        maxMs: Number(renderLatencies[renderLatencies.length - 1].toFixed(4)),
      },
      frameStability: {
        // 60fps budget check: max happy-dom render time vs 16.67ms frame budget
        // Scope: happy-dom microbenchmark, NOT a real browser or GPU frame time
        measurementType: 'happy-dom-60fps-budget-check',
        targetFps: 60,
        maxFrameTimeMs: Number((1000 / 60).toFixed(2)),
        measuredMaxRenderMs: Number(renderLatencies[renderLatencies.length - 1].toFixed(4)),
        passed: renderLatencies[renderLatencies.length - 1] < (1000 / 60),
      },
    },
    memoryBytes: {
      baseline: memBaseline,
      peak: memPeak,
      growthMb: Number(((memPeak - memBaseline) / (1024 * 1024)).toFixed(2)),
    },
  };

  const reportJson = JSON.stringify(report, null, 2);
  // Stable SHA-256 checksum of the artifact content for evidence integrity verification
  const checksum = createHash('sha256').update(reportJson, 'utf8').digest('hex');
  const artifactWithChecksum = { ...report, artifactChecksum: `sha256:${checksum}` };

  console.log('=== UI Benchmark Results ===');
  console.log(JSON.stringify(artifactWithChecksum, null, 2));

  // Save artifact for self-host report validator
  await Bun.write('artifacts/benchmark-ui.json', JSON.stringify(artifactWithChecksum, null, 2));
}

runUiBenchmark().catch((err) => {
  console.error('UI benchmark failed:', err);
  process.exit(1);
});
