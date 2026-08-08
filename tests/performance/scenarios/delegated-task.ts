/**
 * Delegated Task Scenario
 * Benchmark for tasks requiring specialist delegation
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'delegated-task';
const SCENARIO_NAME = 'Delegated Task';
const SCENARIO_DESCRIPTION = 'Task requiring specialist agent delegation';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/index.ts': `export * from './services/user.service';
export * from './services/payment.service';
`,
      'src/services/user.service.ts': `export class UserService {
  async getUser(id: string) {
    return { id, name: 'Test User' };
  }
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add comprehensive caching layer to user service - requires performance specialist',
  expectedOutcome: 'success',
  parentTask: 'Implement caching for user service',
  specialistRequired: '@performance-specialist',
  delegationDepth: 2, // orchestrator -> specialist -> implementation
  verificationCriteria: [
    'Cache interface defined',
    'In-memory cache implementation',
    'TTL support',
    'Cache invalidation on user update',
  ],
};

export const delegatedTaskScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'delegated-task',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 150000,
  isolationLevel: 'memory',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate delegation chain
      const parentPlanning = 100; // orchestrator planning
      const delegation = 50; // specialist handoff
      const specialistWork = 250; // specialist implementation
      const parentReview = 100; // orchestrator review
      const integration = 100; // integrate changes
      
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          parentPlanning + delegation + specialistWork + parentReview + integration
        )
      );
      
      return createMockExecution(
        performance.now() -
        startTime +
        parentPlanning +
        delegation +
        specialistWork +
        parentReview +
        integration,
        'success'
      );
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 60,
          heapTotalMB: 130,
          externalMB: 11,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 4000, output: 2000, total: 6000 },
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
  return delegatedTaskScenario;
}
