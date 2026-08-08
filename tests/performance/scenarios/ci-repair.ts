/**
 * CI Repair Scenario
 * Benchmark for fixing failing CI pipeline
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'ci-repair';
const SCENARIO_NAME = 'CI Repair';
const SCENARIO_DESCRIPTION = 'Fix failing CI pipeline';

const FIXTURE = {
  repositoryState: {
    files: {
      '.github/workflows/ci.yml': `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run tests
        run: npm test
      - name: Run lint
        run: npm run lint
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Fix the failing CI pipeline - test step is failing due to missing env var',
  expectedOutcome: 'success',
  failingStep: 'test',
  errorMessage: 'ENOENT: no such file or directory, open \'./coverage/lcov.info\'',
  fixStrategy: 'Add missing directory creation step before test',
  verificationCriteria: [
    'CI workflow runs successfully',
    'Test step passes',
    'Coverage report is generated',
  ],
};

export const ciRepairScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'ci-repair',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 180000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate CI diagnosis and repair
      const diagnosisDuration = 200; // Analyze failing CI
      const fixDuration = 150; // Apply fix
      const verificationDuration = 300; // Verify fix in CI context
      
      await new Promise((resolve) =>
        setTimeout(resolve, diagnosisDuration + fixDuration + verificationDuration)
      );
      
      return createMockExecution(
        performance.now() - startTime +
        diagnosisDuration + fixDuration + verificationDuration,
        'success'
      );
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 55,
          heapTotalMB: 120,
          externalMB: 10,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 3500, output: 1200, total: 4700 },
        output: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return ciRepairScenario;
}
