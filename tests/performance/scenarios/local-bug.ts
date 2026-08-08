/**
 * Local Bug Scenario
 * Benchmark for bug fix in one module
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'local-bug';
const SCENARIO_NAME = 'Local Bug Fix';
const SCENARIO_DESCRIPTION = 'Bug fix within a single module';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/services/calculator.ts': `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  divide(a: number, b: number): number {
    // Bug: no check for division by zero
    return a / b;
  }
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Fix the division by zero bug in Calculator.divide',
  expectedOutcome: 'success',
  bugDescription: 'Division by zero returns Infinity instead of throwing an error',
  reproductionSteps: [
    'Create Calculator instance',
    'Call divide(10, 0)',
    'Observe: returns Infinity',
    'Expected: throws Error',
  ],
  verificationCriteria: [
    'divide(10, 2) returns 5',
    'divide(10, 0) throws Error',
    'Error message mentions division by zero',
  ],
};

export const localBugScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'local-bug',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 45000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate bug diagnosis and fix
      const diagnosisDuration = 80; // ms - analyze bug
      const fixDuration = 120; // ms - implement fix
      
      await new Promise((resolve) => setTimeout(resolve, diagnosisDuration + fixDuration));
      
      return createMockExecution(
        performance.now() - startTime + diagnosisDuration + fixDuration,
        'success'
      );
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 35,
          heapTotalMB: 85,
          externalMB: 6,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 1200, output: 400, total: 1600 },
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
  return localBugScenario;
}
