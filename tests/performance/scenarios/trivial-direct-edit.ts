/**
 * Trivial Direct Edit Scenario
 * Benchmark for single file edit operations
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'trivial-direct-edit';
const SCENARIO_NAME = 'Trivial Direct Edit';
const SCENARIO_DESCRIPTION = 'Single file edit scenario - basic unit of work';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/utils/helper.ts': `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add a divide function to src/utils/helper.ts',
  expectedOutcome: 'success',
  verificationCriteria: [
    'Function named divide exists',
    'Takes two number parameters',
    'Returns a number',
    'Handles division by zero',
  ],
};

export const trivialDirectEditScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'direct-edit',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 30000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate file edit operation
      // In real scenario, this would use file system operations
      const editDuration = 45; // ms - deterministic mock
      
      await new Promise((resolve) => setTimeout(resolve, editDuration));
      
      return createMockExecution(performance.now() - startTime + editDuration, 'success');
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 30,
          heapTotalMB: 80,
          externalMB: 5,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 800, output: 200, total: 1000 },
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
  return trivialDirectEditScenario;
}
