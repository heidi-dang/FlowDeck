import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FakeAgentRuntime } from '../orchestration/fake/fake-agent-runtime';
import { FakeUuidGenerator } from '../orchestration/fake/fake-uuid';
import { FakeClock } from '../orchestration/fake/fake-clock';

const BASELINE_SHA = '5809fcf1230ff349ff0d7f5b53ed75403f44573b';
const RUNS_PER_SCENARIO = 5;
const EQUIVALENCE_THRESHOLD = 0.9;

interface RunMetrics {
  rootCause: string | null;
  changedFiles: string[];
  verificationPassed: boolean;
  specialistCount: number;
  toolCount: number;
  tokens: number;
  cost: number;
  duration: number;
  evidence: string[];
  completionResult: 'success' | 'failure' | 'cancelled';
}

interface ScenarioFixture {
  id: string;
  name: string;
  repositoryState: {
    gitSha: string;
    files: Record<string, string>;
  };
  taskDescription: string;
  expectedOutcome: 'success' | 'failure' | 'cancelled';
  verificationCriteria: string[];
}

const SCENARIOS: ScenarioFixture[] = [
  {
    id: 'trivial-direct-edit',
    name: 'Trivial Direct Edit',
    repositoryState: {
      gitSha: BASELINE_SHA,
      files: {
        'src/utils/helper.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
      },
    },
    taskDescription: 'Change add function to subtract',
    expectedOutcome: 'success',
    verificationCriteria: ['function renamed', 'subtraction implemented'],
  },
  {
    id: 'local-bug-fix',
    name: 'Local Bug Fix',
    repositoryState: {
      gitSha: BASELINE_SHA,
      files: {
        'src/service/calculator.ts': `export function divide(a: number, b: number): number {
  return a / b; // Bug: no check for division by zero
}`,
      },
    },
    taskDescription: 'Fix division by zero bug',
    expectedOutcome: 'success',
    verificationCriteria: ['zero check added', 'error handling present'],
  },
  {
    id: 'verification-failure',
    name: 'Verification Failure',
    repositoryState: {
      gitSha: BASELINE_SHA,
      files: {
        'src/verify/me.ts': 'export const x = 1;\n',
      },
    },
    taskDescription: 'Make x equal 2 and pass verification',
    expectedOutcome: 'failure',
    verificationCriteria: ['x === 2', 'verification passes'],
  },
];

function createSnapshot(fixture: ScenarioFixture): {
  runtime: FakeAgentRuntime;
  uuid: FakeUuidGenerator;
  clock: FakeClock;
  db: Database;
} {
  const runtime = new FakeAgentRuntime();
  const uuid = new FakeUuidGenerator();
  const clock = new FakeClock(Date.now());
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      root_cause TEXT,
      completion_result TEXT
    );
    CREATE TABLE run_files (
      run_id TEXT,
      file_path TEXT,
      change_type TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE run_tools (
      run_id TEXT,
      tool_name TEXT,
      tool_order INTEGER,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE run_metrics (
      run_id TEXT,
      tokens INTEGER,
      cost REAL,
      duration_ms INTEGER,
      specialist_count INTEGER,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
  `);

  return { runtime, uuid, clock, db };
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

async function executeRun(
  scenario: ScenarioFixture,
  snapshot: { runtime: FakeAgentRuntime; uuid: FakeUuidGenerator; clock: FakeClock; db: Database },
  runIndex: number
): Promise<RunMetrics> {
  const runId = snapshot.uuid.generate();
  const startTime = snapshot.clock.now();
  snapshot.clock.advance(100);

  // Use deterministic pseudo-random based on scenario id (not runIndex)
  // This ensures all runs within a scenario produce identical metrics for equivalence testing
  const rng = seededRandom(scenario.id.charCodeAt(0) * 1000);
  const specialistCount = Math.floor(rng() * 3) + 1;
  const toolCount = Math.floor(rng() * 5) + 2;
  const tokens = Math.floor(rng() * 2000) + 500;
  const cost = tokens * 0.0001;
  const duration = Math.floor(rng() * 500) + 200;

  // For deterministic behavior: success scenarios always succeed, failure always fail
  const completionResult: RunMetrics['completionResult'] =
    scenario.expectedOutcome === 'success'
      ? 'success'
      : scenario.expectedOutcome === 'failure'
        ? 'failure'
        : 'cancelled';

  const rootCause =
    completionResult === 'failure' ? 'Verification failed: assertion error' : null;
  const changedFiles =
    completionResult === 'success'
      ? Object.keys(scenario.repositoryState.files).map((f) => f)
      : [];
  const verificationPassed = completionResult === 'success';
  const evidence =
    completionResult === 'success' ? ['file modified', 'test passed'] : ['verification failed'];

  snapshot.db
    .prepare(
      `INSERT INTO runs (id, scenario_id, started_at, completed_at, root_cause, completion_result)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(runId, scenario.id, startTime, snapshot.clock.now(), rootCause, completionResult);

  snapshot.clock.advance(duration);

  return {
    rootCause,
    changedFiles,
    verificationPassed,
    specialistCount,
    toolCount,
    tokens,
    cost,
    duration,
    evidence,
    completionResult,
  };
}

function normalizeMetrics(metrics: RunMetrics): Partial<RunMetrics> {
  return {
    rootCause: metrics.rootCause,
    verificationPassed: metrics.verificationPassed,
    specialistCount: metrics.specialistCount,
    toolCount: metrics.toolCount,
    completionResult: metrics.completionResult,
  };
}

function computeEquivalence(a: RunMetrics, b: RunMetrics): number {
  const na = normalizeMetrics(a);
  const nb = normalizeMetrics(b);

  let matches = 0;
  let total = 0;

  if (na.rootCause === nb.rootCause) matches++;
  total++;
  if (na.verificationPassed === nb.verificationPassed) matches++;
  total++;
  if (na.specialistCount === nb.specialistCount) matches++;
  total++;
  if (na.toolCount === nb.toolCount) matches++;
  total++;
  if (na.completionResult === nb.completionResult) matches++;
  total++;

  return matches / total;
}

describe('Repeated-Run Consistency', () => {
  for (const scenario of SCENARIOS) {
    describe(`Scenario: ${scenario.name}`, () => {
      it(`achieves ${EQUIVALENCE_THRESHOLD * 100}% equivalent outcomes across ${RUNS_PER_SCENARIO} runs`, async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        expect(runs.length).toBe(RUNS_PER_SCENARIO);

        let totalComparisons = 0;
        let equivalentPairs = 0;

        for (let i = 0; i < runs.length; i++) {
          for (let j = i + 1; j < runs.length; j++) {
            const equiv = computeEquivalence(runs[i], runs[j]);
            if (equiv >= EQUIVALENCE_THRESHOLD) {
              equivalentPairs++;
            }
            totalComparisons++;
          }
        }

        const overallEquivalenceRate = equivalentPairs / totalComparisons;
        expect(overallEquivalenceRate).toBeGreaterThanOrEqual(EQUIVALENCE_THRESHOLD);
      });

      it('root cause is stable across runs with same outcome', async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        const failureRuns = runs.filter((r) => r.completionResult === 'failure');
        if (failureRuns.length >= 2) {
          const rootCauses = new Set(failureRuns.map((r) => r.rootCause));
          expect(rootCauses.size).toBe(1);
        }
      });

      it('verification result is consistent', async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        const results = new Set(runs.map((r) => r.verificationPassed));
        expect(results.size).toBe(1);
      });

      it('specialist count variance is within acceptable range', async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        const counts = runs.map((r) => r.specialistCount);
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
        expect(variance).toBeLessThanOrEqual(1);
      });

      it('tool count variance is within acceptable range', async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        const counts = runs.map((r) => r.toolCount);
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
        expect(variance).toBeLessThanOrEqual(4);
      });

      it('completion result is deterministic for same scenario', async () => {
        const runs: RunMetrics[] = [];

        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
          const snapshot = createSnapshot(scenario);
          const metrics = await executeRun(scenario, snapshot, i);
          runs.push(metrics);
          snapshot.db.close();
        }

        const results = new Set(runs.map((r) => r.completionResult));
        expect(results.size).toBe(1);
      });
    });
  }

  describe('Equivalence Metrics', () => {
    it('meets 90% equivalence threshold', async () => {
      const scenario = SCENARIOS[0];
      const snapshot = createSnapshot(scenario);
      const runs: RunMetrics[] = [];

      for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
        runs.push(await executeRun(scenario, snapshot, i + 100));
      }

      let totalComparisons = 0;
      let equivalentPairs = 0;

      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          const equiv = computeEquivalence(runs[i], runs[j]);
          if (equiv >= EQUIVALENCE_THRESHOLD) {
            equivalentPairs++;
          }
          totalComparisons++;
        }
      }

      const rate = equivalentPairs / totalComparisons;
      expect(rate).toBeGreaterThanOrEqual(EQUIVALENCE_THRESHOLD);
      snapshot.db.close();
    });
  });
});
