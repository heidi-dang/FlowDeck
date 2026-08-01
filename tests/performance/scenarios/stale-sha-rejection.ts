/**
 * Stale SHA Rejection Scenario
 * Benchmark for commit changed during execution
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'stale-sha-rejection';
const SCENARIO_NAME = 'Stale SHA Rejection';
const SCENARIO_DESCRIPTION = 'Task detects that commit changed during execution';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/config/settings.ts': `export interface Settings {
  debug: boolean;
  logLevel: 'info' | 'warn' | 'error';
  timeout: number;
}

export const defaultSettings: Settings = {
  debug: false,
  logLevel: 'info',
  timeout: 5000,
};

export function validateSettings(settings: Partial<Settings>): boolean {
  if (settings.timeout && settings.timeout < 0) return false;
  return true;
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add environment-specific configuration merging to settings module',
  expectedOutcome: 'failure',
  verificationCriteria: [
    'Merge function exists',
    'Environment overrides work correctly',
    'Type safety maintained',
  ],
};

export const staleShaRejectionScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'stale-sha-rejection',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 30000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate stale SHA detection
      const detectionTime = 50;
      await new Promise((resolve) => setTimeout(resolve, detectionTime));
      
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 28,
          heapTotalMB: 75,
          externalMB: 5,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 900, output: 250, total: 1150 },
        output: null,
        error: 'Stale SHA detected: commit changed during execution',
      };
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 28,
          heapTotalMB: 75,
          externalMB: 5,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 900, output: 250, total: 1150 },
        output: null,
        error: error instanceof Error ? error.message : 'SHA validation error',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return staleShaRejectionScenario;
}
