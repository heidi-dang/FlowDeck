/**
 * Recovery Scenario
 * Benchmark for task with failure injection and recovery
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'recovery';
const SCENARIO_NAME = 'Recovery';
const SCENARIO_DESCRIPTION = 'Task that experiences failure and recovers';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/service/api-client.ts': `export interface ApiResponse<T> {
  data?: T;
  error?: string;
  statusCode: number;
}

export class ApiClient {
  async get<T>(url: string): Promise<ApiResponse<T>> {
    return { statusCode: 200 };
  }

  async post<T>(url: string, body: unknown): Promise<ApiResponse<T>> {
    return { statusCode: 201 };
  }
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add exponential backoff retry logic to the API client',
  expectedOutcome: 'success',
  verificationCriteria: [
    'Retry mechanism with exponential backoff',
    'Maximum retry attempts configurable',
    'Handles timeout errors gracefully',
    'Returns original error after max retries',
  ],
};

export const recoveryScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'recovery',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 60000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate failure injection and recovery
      const initialFailure = 30;
      const recoveryTime = 70;
      
      await new Promise((resolve) => setTimeout(resolve, initialFailure));
      
      // Recovery succeeds
      return createMockExecution(performance.now() - startTime + recoveryTime, 'success');
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 40,
          heapTotalMB: 90,
          externalMB: 7,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 1400, output: 500, total: 1900 },
        output: null,
        error: error instanceof Error ? error.message : 'Recovery failed',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return recoveryScenario;
}
