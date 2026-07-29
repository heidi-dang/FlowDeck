import type { DomainEvent } from './events/envelope.js';

/**
 * Task Run Aggregate - Core runtime state machine
 * 
 * States: created, planning, analysing, delegating, executing, verifying, recovering, completed, failed, cancelled
 * Strategies: simple, planned, delegated, audit, recovery
 */

/**
 * Valid task run states
 */
export type TaskRunState = 
  | 'created'
  | 'planning'
  | 'analysing'
  | 'delegating'
  | 'executing'
  | 'verifying'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Execution strategies
 */
export type TaskRunStrategy = 
  | 'simple'
  | 'planned'
  | 'delegated'
  | 'audit'
  | 'recovery';

/**
 * Terminal states that cannot be modified (except explicit recovery flows)
 */
const TERMINAL_STATES: Set<TaskRunState> = new Set(['completed', 'failed', 'cancelled']);

/**
 * TaskRun aggregate interface
 */
export interface TaskRun {
  readonly aggregateId: string;
  readonly version: number;
  readonly status: TaskRunState; // Alias for state
  readonly strategy: TaskRunStrategy;
  
  // Runtime-specific fields
  readonly correlationId?: string;
  readonly planScope?: unknown;
  readonly delegationTarget?: string;
  readonly delegationMode?: string;
  readonly recoveryPath?: string;
  readonly failedStage?: string;
  
  // Invariant state flags
  readonly planningCompleted?: boolean;
  readonly analysisComplete?: boolean;
  readonly agentResponseReceived?: boolean;
  readonly executionComplete?: boolean;
  readonly acceptanceCriteriaMet?: boolean;
  readonly needsRecovery?: boolean;
  readonly agentFailedOrTimeout?: boolean;
  readonly executableFailed?: boolean;
  readonly verificationFailed?: boolean;
  readonly recoveryComplete?: boolean;
  readonly recoveryExhausted?: boolean;
  readonly planExists?: boolean;
  readonly delegationConfigured?: boolean;
  readonly auditTrailEnabled?: boolean;
  readonly recoveryPathDefined?: boolean;
}

/**
 * Transition definition
 */
export interface TransitionDefinition {
  source: TaskRunState;
  target: TaskRunState;
  command: string;
  invariants: ((run: TaskRun) => boolean)[];
  emit: () => DomainEvent[];
  idempotency: {
    dedupKey: string;
    behavior: 'reject' | 'noOp';
  };
}

/**
 * Complete transition matrix
 */
export const TRANSITION_MATRIX: Record<string, TransitionDefinition[]> = {
  created: [
    {
      source: 'created',
      target: 'planning',
      command: 'StartPlanningCommand',
      invariants: [(run: TaskRun) => run.strategy === 'planned' || run.strategy === 'simple'],
      emit: () => [],
      idempotency: {
        dedupKey: 'start-planning',
        behavior: 'noOp'
      }
    },
    {
      source: 'created',
      target: 'failed',
      command: 'FailCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-created',
        behavior: 'reject'
      }
    },
    {
      source: 'created',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-created',
        behavior: 'noOp'
      }
    }
  ],
  planning: [
    {
      source: 'planning',
      target: 'analysing',
      command: 'StartAnalysisCommand',
      invariants: [(run: TaskRun) => run.planningCompleted === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'start-analysis',
        behavior: 'noOp'
      }
    },
    {
      source: 'planning',
      target: 'delegating',
      command: 'DelegateToAgentCommand',
      invariants: [(run: TaskRun) => run.strategy === 'delegated'],
      emit: () => [],
      idempotency: {
        dedupKey: 'delegate',
        behavior: 'noOp'
      }
    },
    {
      source: 'planning',
      target: 'failed',
      command: 'FailCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-planning',
        behavior: 'reject'
      }
    },
    {
      source: 'planning',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-planning',
        behavior: 'noOp'
      }
    }
  ],
  analysing: [
    {
      source: 'analysing',
      target: 'delegating',
      command: 'StartExecutionCommand',
      invariants: [(run: TaskRun) => run.analysisComplete === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'start-execution',
        behavior: 'noOp'
      }
    },
    {
      source: 'analysing',
      target: 'recovering',
      command: 'InitiateRecoveryCommand',
      invariants: [(run: TaskRun) => run.needsRecovery === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'initiate-recovery',
        behavior: 'noOp'
      }
    },
    {
      source: 'analysing',
      target: 'failed',
      command: 'FailCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-analysing',
        behavior: 'reject'
      }
    },
    {
      source: 'analysing',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-analysing',
        behavior: 'noOp'
      }
    }
  ],
  delegating: [
    {
      source: 'delegating',
      target: 'executing',
      command: 'ResumeExecutionCommand',
      invariants: [(run: TaskRun) => run.agentResponseReceived === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'resume-execution',
        behavior: 'noOp'
      }
    },
    {
      source: 'delegating',
      target: 'recovering',
      command: 'InitiateRecoveryCommand',
      invariants: [(run: TaskRun) => run.agentFailedOrTimeout === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'initiate-recovery',
        behavior: 'noOp'
      }
    },
    {
      source: 'delegating',
      target: 'failed',
      command: 'FailCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-delegating',
        behavior: 'reject'
      }
    },
    {
      source: 'delegating',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-delegating',
        behavior: 'noOp'
      }
    }
  ],
  executing: [
    {
      source: 'executing',
      target: 'verifying',
      command: 'CompleteExecutionCommand',
      invariants: [(run: TaskRun) => run.executionComplete === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'complete-execution',
        behavior: 'noOp'
      }
    },
    {
      source: 'executing',
      target: 'recovering',
      command: 'InitiateRecoveryCommand',
      invariants: [(run: TaskRun) => run.executableFailed === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'initiate-recovery',
        behavior: 'noOp'
      }
    },
    {
      source: 'executing',
      target: 'failed',
      command: 'FailCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-executing',
        behavior: 'reject'
      }
    },
    {
      source: 'executing',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-executing',
        behavior: 'noOp'
      }
    }
  ],
  verifying: [
    {
      source: 'verifying',
      target: 'completed',
      command: 'CompleteTaskCommand',
      invariants: [(run: TaskRun) => run.acceptanceCriteriaMet === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'complete-task',
        behavior: 'noOp'
      }
    },
    {
      source: 'verifying',
      target: 'recovering',
      command: 'InitiateRecoveryCommand',
      invariants: [(run: TaskRun) => run.verificationFailed === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'initiate-recovery',
        behavior: 'noOp'
      }
    },
    {
      source: 'verifying',
      target: 'failed',
      command: 'FailCommand',
      invariants: [(run: TaskRun) => (run.acceptanceCriteriaMet !== true) && (run.verificationFailed !== true)],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-verifying',
        behavior: 'reject'
      }
    },
    {
      source: 'verifying',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-verifying',
        behavior: 'noOp'
      }
    }
  ],
  recovering: [
    {
      source: 'recovering',
      target: 'executing',
      command: 'ResumeAfterRecoveryCommand',
      invariants: [(run: TaskRun) => run.recoveryComplete === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'resume-after-recovery',
        behavior: 'noOp'
      }
    },
    {
      source: 'recovering',
      target: 'failed',
      command: 'FailCommand',
      invariants: [(run: TaskRun) => run.recoveryExhausted === true],
      emit: () => [],
      idempotency: {
        dedupKey: 'fail-recovering',
        behavior: 'reject'
      }
    },
    {
      source: 'recovering',
      target: 'cancelled',
      command: 'CancelCommand',
      invariants: [],
      emit: () => [],
      idempotency: {
        dedupKey: 'cancel-recovering',
        behavior: 'noOp'
      }
    }
  ],
  completed: [], // Terminal - no transitions except explicit recovery via external coordinator
  failed: [], // Terminal
  cancelled: [] // Terminal
};

/**
 * Strategy-specific validation rules
 */
export const STRATEGY_RULES: Record<TaskRunStrategy, (run: TaskRun) => boolean> = {
  simple: (_run: TaskRun) => true,
  planned: (run: TaskRun) => run.strategy === 'planned',
  delegated: (run: TaskRun) => run.strategy === 'delegated',
  audit: (run: TaskRun) => run.strategy === 'audit',
  recovery: (run: TaskRun) => run.strategy === 'recovery'
};

// Re-export constants for test access
export { TERMINAL_STATES };
