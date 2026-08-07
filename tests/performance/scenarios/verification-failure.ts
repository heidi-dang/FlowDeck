/**
 * Verification Failure Scenario
 * Benchmark for task with failing verification
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'verification-failure';
const SCENARIO_NAME = 'Verification Failure';
const SCENARIO_DESCRIPTION = 'Task that fails verification and requires iteration';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/validator/input.ts': `export interface ValidationInput {
  value: string;
  maxLength?: number;
}

export function validate(input: ValidationInput): boolean {
  if (!input.value) return false;
  if (input.maxLength && input.value.length > input.maxLength) {
    return false;
  }
  return true;
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add email validation to the validator module',
  expectedOutcome: 'failure',
  verificationCriteria: [
    'Function accepts email string',
    'Returns boolean',
    'Rejects invalid email formats',
    'Accepts valid email formats',
  ],
};

export const verificationFailureScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'verification-failure',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 45000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate first attempt fails verification, second attempt succeeds
      const attemptDuration = 80;
      await new Promise((resolve) => setTimeout(resolve, attemptDuration));
      
      // First verification fails
      return createMockExecution(performance.now() - startTime + attemptDuration, 'failure');
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
        error: error instanceof Error ? error.message : 'Verification failed',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return verificationFailureScenario;
}
