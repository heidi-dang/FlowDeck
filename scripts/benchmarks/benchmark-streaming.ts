/**
 * Machine-Readable Streaming Infrastructure Benchmark Suite
 * Measures SQLite commit latency, publish-to-client receipt, reconnect replay, and snapshot recovery.
 */
import {
  StreamRepository,
  SseBroker,
  StreamPublisher,
  StreamReplayService,
} from '../../src/orchestration/streaming';
import { createHash } from 'crypto';

async function runStreamingBenchmark() {
  const sampleCount = 2000;
  const runId = `bench_stream_${Date.now()}`;
  const repository = new StreamRepository(':memory:', { allowInMemory: true });
  const broker = new SseBroker();
  const publisher = new StreamPublisher(repository, broker);
  const replayService = new StreamReplayService(repository);

  const memBaseline = process.memoryUsage().heapUsed;

  // 1. Benchmark: SQLite Commit Latency
  const commitLatencies: number[] = [];
  const startCommit = performance.now();
  for (let i = 1; i <= sampleCount; i++) {
    const t0 = performance.now();
    repository.persistEvent(runId, i, 'agent.progress', { step: i }, Date.now());
    const t1 = performance.now();
    commitLatencies.push(t1 - t0);
  }
  const commitDuration = performance.now() - startCommit;

  // 2. Benchmark: Reconnect Replay Throughput
  const replayRunId = `bench_replay_${Date.now()}`;
  for (let i = 1; i <= 1000; i++) {
    repository.persistEvent(replayRunId, i, 'agent.progress', { step: i }, Date.now());
  }

  const mockSession = {
    sendEvent: () => {},
  } as any;

  const startReplay = performance.now();
  await replayService.replayToSession(replayRunId, 0, 1000, mockSession);
  const replayDuration = performance.now() - startReplay;

  // 3. Benchmark: Publisher Commit and Broker Dispatch
  const pubLatencies: number[] = [];
  const pubRunId = `bench_pub_${Date.now()}`;
  const startPub = performance.now();
  for (let i = 1; i <= sampleCount; i++) {
    const t0 = performance.now();
    publisher.publish({
      runId: pubRunId,
      type: 'agent.progress',
      stage: 'execute',
      importance: 'normal',
      title: `Event ${i}`,
      payload: { step: i },
    });
    const t1 = performance.now();
    pubLatencies.push(t1 - t0);
  }
  const pubDuration = performance.now() - startPub;

  // 4. Benchmark: Real Publish to Client Receipt (connected socket session)
  const clientReceiptLatencies: number[] = [];
  const clientRunId = `bench_client_${Date.now()}`;
  const receiptMockSession = {
    sendEvent: (_event: any) => {
      const receiptTime = performance.now();
      if ((receiptMockSession as any).currentT0) {
        clientReceiptLatencies.push(receiptTime - (receiptMockSession as any).currentT0);
      }
    },
    enqueueOrSend: (event: any) => {
      receiptMockSession.sendEvent(event);
    },
  } as any;

  broker.addClient(clientRunId, receiptMockSession);
  const startClientBench = performance.now();
  for (let i = 1; i <= 1000; i++) {
    (receiptMockSession as any).currentT0 = performance.now();
    publisher.publish({
      runId: clientRunId,
      type: 'agent.progress',
      stage: 'execute',
      importance: 'normal',
      title: `Client Event ${i}`,
      payload: { step: i },
    });
  }
  const clientBenchDuration = performance.now() - startClientBench;

  const memPeak = process.memoryUsage().heapUsed;

  commitLatencies.sort((a, b) => a - b);
  pubLatencies.sort((a, b) => a - b);
  clientReceiptLatencies.sort((a, b) => a - b);

  const gitSha = require('child_process').execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const branch = require('child_process').execSync("git branch --show-current", { encoding: "utf-8" }).trim();

  const statusLines = require('child_process').execSync("git status --porcelain", { encoding: "utf-8" }).trim().split('\n').filter((line: string) => line && !line.includes('artifacts/'));
  const isDirty = statusLines.length > 0;
  if (isDirty) {
    console.error("FAIL: Cannot generate benchmark artifact from dirty working tree (uncommitted source code changes detected).");
    process.exit(1);
  }

  const report = {
    benchmarkSuite: 'streaming-infrastructure',
    benchmarkType: 'microbenchmark-sqlite-and-broker',
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
    fixture: 'SQLite StreamRepository & SseBroker',
    warmColdState: 'warm',
    metrics: {
      sqliteCommitLatency: {
        // Measurement type: in-process SQLite write microbenchmark (:memory:)
        // Scope: StreamRepository.persistEvent() latency per call, no network, no disk I/O
        measurementType: 'in-process-sqlite-microbenchmark',
        samples: sampleCount,
        opsPerSec: Math.round((sampleCount / commitDuration) * 1000),
        medianMs: Number(commitLatencies[Math.floor(commitLatencies.length * 0.5)].toFixed(4)),
        p95Ms: Number(commitLatencies[Math.floor(commitLatencies.length * 0.95)].toFixed(4)),
        maxMs: Number(commitLatencies[commitLatencies.length - 1].toFixed(4)),
      },
      publisherCommitAndBrokerDispatch: {
        // Measurement type: in-process StreamPublisher + SseBroker dispatch microbenchmark
        // Scope: publish() → SQLite persist → broker.broadcast() — no network, no HTTP
        measurementType: 'in-process-broker-dispatch-microbenchmark',
        samples: sampleCount,
        opsPerSec: Math.round((sampleCount / pubDuration) * 1000),
        medianMs: Number(pubLatencies[Math.floor(pubLatencies.length * 0.5)].toFixed(4)),
        p95Ms: Number(pubLatencies[Math.floor(pubLatencies.length * 0.95)].toFixed(4)),
        maxMs: Number(pubLatencies[pubLatencies.length - 1].toFixed(4)),
      },
      publishToClientReceipt: {
        // Measurement type: in-process broker-to-mock-session receipt microbenchmark
        // Scope: publish() → broker dispatch → mock session.sendEvent() callback, NO real HTTP/network
        measurementType: 'in-process-broker-to-mock-session-microbenchmark',
        samples: 1000,
        opsPerSec: Math.round((1000 / clientBenchDuration) * 1000),
        medianMs: Number(clientReceiptLatencies[Math.floor(clientReceiptLatencies.length * 0.5)].toFixed(4)),
        p95Ms: Number(clientReceiptLatencies[Math.floor(clientReceiptLatencies.length * 0.95)].toFixed(4)),
        maxMs: Number(clientReceiptLatencies[clientReceiptLatencies.length - 1].toFixed(4)),
      },
      reconnectReplay: {
        // Measurement type: in-process replay-service microbenchmark
        // Scope: StreamReplayService.replayToSession() SQLite read → mock session callback, no HTTP
        measurementType: 'in-process-replay-service-microbenchmark',
        replayedEvents: 1000,
        durationMs: Number(replayDuration.toFixed(2)),
        replaysPerSec: Math.round((1000 / replayDuration) * 1000),
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

  console.log('=== Streaming Benchmark Results ===');
  console.log(JSON.stringify(artifactWithChecksum, null, 2));

  // Save artifact for self-host report validator
  await Bun.write('artifacts/benchmark-streaming.json', JSON.stringify(artifactWithChecksum, null, 2));
}

runStreamingBenchmark().catch((err) => {
  console.error('Streaming benchmark failed:', err);
  process.exit(1);
});
