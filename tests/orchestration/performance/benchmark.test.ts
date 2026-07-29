import { describe, it, expect } from 'bun:test';
import Database from 'better-sqlite3';
import { SCHEMA_V_0_2_6 } from '../../../src/orchestration/persistence/migrations/schema-embed';

function measure(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function runBenchmark(name: string, warmup: number, iterations: number, fn: () => void, maxThresholdMs: number) {
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    times.push(measure(fn));
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const maximum = times[times.length - 1];

  console.log(`[BENCHMARK] ${name}: median=${median.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${maximum.toFixed(2)}ms, threshold=${maxThresholdMs}ms`);

  // We log the benchmark, but to avoid flaky CI, we only enforce hard correctness limits
  // with a very generous max threshold, or we just don't fail unless it's catastrophic.
  expect(median).toBeLessThanOrEqual(maxThresholdMs);
}

describe('Performance Benchmarks', () => {
  it('benchmarks schema creation', () => {
    runBenchmark('Schema Creation', 2, 10, () => {
      const db = new Database(':memory:');
      db.exec(SCHEMA_V_0_2_6);
      db.close();
    }, 100);
  });

  it('benchmarks 1,000 event appends', () => {
    runBenchmark('1,000 event appends', 1, 3, () => {
      const db = new Database(':memory:');
      db.exec(SCHEMA_V_0_2_6);
      db.exec('BEGIN TRANSACTION');
      const stmt = db.prepare('INSERT INTO events (event_id, aggregate_type, aggregate_id, aggregate_version, event_type, data) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 1000; i++) {
        stmt.run(`ev-${i}`, 'Agg', 'a1', i + 1, 'TestEvent', '{}');
      }
      db.exec('COMMIT');
      db.close();
    }, 2000); // SQLite in-memory can easily do 1k inserts in < 50ms, generously 2000ms
  });
});
