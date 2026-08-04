/**
 * Scenario Base Types
 * Common interfaces for all benchmark scenarios
 */

import type {
  BenchmarkScenario,
  BenchmarkExecution,
  ScenarioFixture,
} from '../benchmark-runner';

export { BenchmarkScenario, BenchmarkExecution, ScenarioFixture };

export interface DirectEditScenario extends BenchmarkScenario {
  category: 'direct-edit';
  fileToEdit: string;
  originalContent: string;
  newContent: string;
}

export interface LocalBugScenario extends BenchmarkScenario {
  category: 'local-bug';
  buggyFile: string;
  bugDescription: string;
  fixContent: string;
  reproductionSteps: string[];
}

export interface CrossModuleScenario extends BenchmarkScenario {
  category: 'cross-module';
  affectedModules: string[];
  featureDescription: string;
}

export interface CIRepairScenario extends BenchmarkScenario {
  category: 'ci-repair';
  failingStep: string;
  errorMessage: string;
  fixStrategy: string;
}

export interface ReadOnlyAuditScenario extends BenchmarkScenario {
  category: 'read-only-audit';
  analysisTarget: string;
  findingsExpected: number;
}

export interface DelegatedTaskScenario extends BenchmarkScenario {
  category: 'delegated-task';
  parentTask: string;
  specialistRequired: string;
  delegationDepth: number;
}

export interface VerificationFailureScenario extends BenchmarkScenario {
  category: 'verification-failure';
  taskDescription: string;
  failingCriterion: string;
  attemptsExpected: number;
}

export interface CancellationScenario extends BenchmarkScenario {
  category: 'cancellation';
  taskToCancel: string;
  cancellationPoint: 'planning' | 'analysis' | 'execution' | 'verification';
}

export interface RecoveryScenario extends BenchmarkScenario {
  category: 'recovery';
  failureInjection: string;
  recoveryStrategy: string;
  expectedRecoveryTime: number;
}

export interface StaleShaRejectionScenario extends BenchmarkScenario {
  category: 'stale-sha-rejection';
  originalSha: string;
  changedFiles: string[];
  rejectionDetectionTime: number;
}

export interface ParallelConflictScenario extends BenchmarkScenario {
  category: 'parallel-conflict';
  conflictingTasks: string[];
  conflictResolution: string;
  resolutionTime: number;
}

export interface FDXParityScenario extends BenchmarkScenario {
  category: 'fdx-parity';
  nativeExecution: () => Promise<BenchmarkExecution>;
  fallbackExecution: () => Promise<BenchmarkExecution>;
  parityThreshold: number; // percentage
}

export function createMockExecution(
  duration: number = 100,
  status: 'success' | 'failure' = 'success'
): BenchmarkExecution {
  return {
    status,
    duration,
    memorySnapshot: {
      heapUsedMB: 50,
      heapTotalMB: 100,
      externalMB: 10,
      timestamp: Date.now(),
    },
    tokenCounts: {
      input: 1000,
      output: 500,
      total: 1500,
    },
    output: { mock: 'output' },
    error: status === 'failure' ? 'Mock error' : undefined,
  };
}

export function createDeterministicScenario(
  id: string,
  name: string,
  description: string,
  category: BenchmarkScenario['category'],
  executionTime: number = 100
): BenchmarkScenario {
  return {
    id,
    name,
    description,
    category,
    baselineIterations: 3,
    milestoneIterations: 5,
    timeout: 30000,
    isolationLevel: 'memory',
    async execute() {
      // Simulate deterministic execution
      await new Promise((resolve) => setTimeout(resolve, executionTime));
      return createMockExecution(executionTime);
    },
  };
}
