/**
 * Cancellation Scenario
 * Benchmark for task cancelled mid-execution
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';

const SCENARIO_ID = 'cancellation';
const SCENARIO_NAME = 'Cancellation';
const SCENARIO_DESCRIPTION = 'Task cancelled at various execution points';

type CancellationPoint = 'planning' | 'analysis' | 'execution' | 'verification';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/processor/data.ts': `export interface DataProcessor {
  process(data: unknown[]): Promise<unknown[]>;
  validate(data: unknown[]): boolean;
}

export class BasicProcessor implements DataProcessor {
  async process(data: unknown[]): Promise<unknown[]> {
    return data.map(item => ({ ...item as object, processed: true }));
  }

  validate(data: unknown[]): boolean {
    return Array.isArray(data);
  }
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add batch processing with retry logic to the data processor',
  expectedOutcome: 'cancelled',
  verificationCriteria: [
    'Batch size configuration exists',
    'Retry mechanism implemented',
    'Error handling for failed items',
  ],
};

export const cancellationScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'cancellation',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 30000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate cancellation at execution point
      const cancellationDuration = 60;
      await new Promise((resolve) => setTimeout(resolve, cancellationDuration));
      
      // Task was cancelled
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 25,
          heapTotalMB: 70,
          externalMB: 4,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 600, output: 150, total: 750 },
        output: null,
        error: 'Task cancelled by user',
      };
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 25,
          heapTotalMB: 70,
          externalMB: 4,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 600, output: 150, total: 750 },
        output: null,
        error: error instanceof Error ? error.message : 'Cancellation error',
      };
    }
  },
};

export function getCancellationScenario(point: CancellationPoint): BenchmarkScenario {
  return {
    ...cancellationScenario,
    id: `${SCENARIO_ID}-${point}`,
  };
}

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return cancellationScenario;
}
