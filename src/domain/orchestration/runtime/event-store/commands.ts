/**
 * Typed Runtime Commands with Command Idempotency - Phase 3B
 * 
 * Defines all runtime commands with strict typing for exact expected-version validation
 */

import { TaskRunState } from './task-run.js';

/**
 * Base command interface
 */
export interface BaseCommand {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly commandId: string; // Globally unique per attempt
  readonly correlationId?: string;
  readonly causationId?: string; // Event ID that triggered this
}

/**
 * Initiate/Start commands
 */
export interface StartPlanningCommand extends BaseCommand {
  readonly type: 'StartPlanningCommand';
  readonly payload: {
    readonly planningStep?: string;
    readonly planScope?: unknown;
  };
}

export interface StartAnalysisCommand extends BaseCommand {
  readonly type: 'StartAnalysisCommand';
  readonly payload: {
    readonly analysisTarget?: string;
    readonly analysisType?: string;
  };
}

export interface StartExecutionCommand extends BaseCommand {
  readonly type: 'StartExecutionCommand';
  readonly payload: {
    readonly delegationTarget?: string;
    readonly mode?: string;
  };
}

/**
 * Completion commands
 */
export interface CompletePlanningCommand extends BaseCommand {
  readonly type: 'CompletePlanningCommand';
  readonly payload: {
    readonly planScope?: unknown;
    readonly analysisRequired: boolean;
  };
}

export interface CompleteAnalysisCommand extends BaseCommand {
  readonly type: 'CompleteAnalysisCommand';
  readonly payload: {
    readonly analysisResults?: unknown;
    readonly assignmentsCreated?: string[];
  };
}

export interface CompleteExecutionCommand extends BaseCommand {
  readonly type: 'CompleteExecutionCommand';
  readonly payload: {
    readonly result?: unknown;
    readonly failureReason?: string;
  };
}

/**
 * Verification commands
 */
export interface VerifyCommand extends BaseCommand {
  readonly type: 'VerifyCommand';
  readonly payload: {
    readonly criteriaMet?: boolean;
    readonly acceptanceResult?: unknown;
  };
}

/**
 * Terminal commands
 */
export interface CompleteTaskCommand extends BaseCommand {
  readonly type: 'CompleteTaskCommand';
  readonly payload: {
    readonly finalOutcome?: unknown;
  };
}

export interface FailTaskCommand extends BaseCommand {
  readonly type: 'FailTaskCommand';
  readonly payload: {
    readonly errorType: string;
    readonly errorMessage: string;
    readonly stackTrace?: string;
  };
}

export interface CancelTaskCommand extends BaseCommand {
  readonly type: 'CancelTaskCommand';
  readonly payload: {
    readonly cancellationReason: string;
    readonly initiatedBy?: string;
  };
}

/**
 * Recovery commands
 */
export interface InitiateRecoveryCommand extends BaseCommand {
  readonly type: 'InitiateRecoveryCommand';
  readonly payload: {
    readonly recoveryPath?: string;
    readonly recoveredFrom?: TaskRunState;
  };
}

/**
 * All runtime command types (union)
 */
export type RuntimeCommand =
  | StartPlanningCommand
  | StartAnalysisCommand
  | StartExecutionCommand
  | CompletePlanningCommand
  | CompleteAnalysisCommand
  | CompleteExecutionCommand
  | VerifyCommand
  | CompleteTaskCommand
  | FailTaskCommand
  | CancelTaskCommand
  | InitiateRecoveryCommand;

/**
 * Command factory functions
 */
export function createStartPlanningCommand(
  aggregateId: string,
  payload: StartPlanningCommand['payload'],
  options?: { commandId?: string; correlationId?: string; causationId?: string }
): StartPlanningCommand {
  return {
    type: 'StartPlanningCommand',
    aggregateId,
    payload,
    commandId: options?.commandId ?? `cmd_${aggregateId}_start_planning_${Date.now()}`,
    correlationId: options?.correlationId,
    causationId: options?.causationId
  };
}

export function createCompletePlanningCommand(
  aggregateId: string,
  payload: CompletePlanningCommand['payload'],
  options?: { commandId?: string; correlationId?: string; causationId?: string }
): CompletePlanningCommand {
  return {
    type: 'CompletePlanningCommand',
    aggregateId,
    payload,
    commandId: options?.commandId ?? `cmd_${aggregateId}_complete_planning_${Date.now()}`,
    correlationId: options?.correlationId,
    causationId: options?.causationId
  };
}

// ... add other factories as needed

/**
 * Expected-version validation
 */
export class VersionValidator {
  static validate(expectedVersion: number, actualVersion: number): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (expectedVersion < actualVersion) {
      errors.push(`Stale version: expected ${actualVersion}, got ${expectedVersion}`);
    }

    if (expectedVersion > actualVersion) {
      errors.push(`Future version: expected ${actualVersion}, got ${expectedVersion}`);
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }
}

/**
 * Duplicate command detection
 */
export class CommandIdempotencyChecker {
  private commandIndex = new Map<string, string>(); // commandId → eventId

  /**
   * Check if command was already processed
   */
  isDuplicate(commandId: string): boolean {
    return this.commandIndex.has(commandId);
  }

  /**
   * Register successful command execution
   */
  register(commandId: string, eventId: string): void {
    this.commandIndex.set(commandId, eventId);
  }

  /**
   * Get existing event for duplicate command
   */
  getExistingEvent(commandId: string): string | undefined {
    return this.commandIndex.get(commandId);
  }

  /**
   * Clear command index (for cleanup tests)
   */
  clear(): void {
    this.commandIndex.clear();
  }
}
