/**
 * Parallel Ownership Conflict Scenario
 * Benchmark for two tasks conflicting on ownership
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';

const SCENARIO_ID = 'parallel-ownership-conflict';
const SCENARIO_NAME = 'Parallel Ownership Conflict';
const SCENARIO_DESCRIPTION = 'Two tasks conflict on file ownership';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/shared/constants.ts': `export const APP_NAME = 'FlowDeck';
export const VERSION = '1.0.0';
export const MAX_RETRY_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT = 5000;
`,
      'src/agent/task-queue.ts': `export interface Task {
  id: string;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export class TaskQueue {
  private tasks: Task[] = [];

  add(task: Task): void {
    this.tasks.push(task);
  }

  next(): Task | undefined {
    return this.tasks.shift();
  }
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Task A modifies constants.ts while Task B also modifies constants.ts',
  expectedOutcome: 'failure',
  verificationCriteria: [
    'Conflict detected',
    'Proper resolution strategy applied',
    'Both changes preserved',
  ],
};

export const parallelOwnershipConflictScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'parallel-conflict',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 45000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate parallel execution with conflict
      const conflictDetection = 65;
      await new Promise((resolve) => setTimeout(resolve, conflictDetection));
      
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 32,
          heapTotalMB: 80,
          externalMB: 6,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 1100, output: 350, total: 1450 },
        output: null,
        error: 'Ownership conflict: two tasks claim same file',
      };
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 32,
          heapTotalMB: 80,
          externalMB: 6,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 1100, output: 350, total: 1450 },
        output: null,
        error: error instanceof Error ? error.message : 'Conflict resolution error',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return parallelOwnershipConflictScenario;
}
