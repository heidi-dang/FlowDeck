/**
 * Domain service for task run state transitions
 * Enforces all invariants and emits events through aggregate
 */

import type { TaskRun, TaskRunState } from './task-run.js';

import { TRANSITION_MATRIX, STRATEGY_RULES, type TransitionDefinition } from './task-run.js';

/**
 * Command interface for task run state changes
 */
export interface Command<T = unknown> {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: T;
  readonly commandId: string; // For idempotency
  readonly correlationId: string;
  readonly causationId?: string;
}

/**
 * State transition processor
 */
export class TransitionProcessor {
  /**
   * Validate transition based on current state and command
   */
  static validateTransition(
    run: TaskRun,
    command: Command
  ): { valid: true; definition: TransitionDefinition } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    // Check if terminal state
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      // Terminal states can only be modified via explicit recovery flows
      if (command.type !== 'InitiateRecoveryCommand' && command.type !== 'CompleteTaskCommand') {
        errors.push(`Cannot transition from terminal state ${run.status} with command ${command.type}`);
        return { valid: false, errors };
      }
    }

    // Find matching transition
    const availableTransitions = TRANSITION_MATRIX[run.status];
    if (!availableTransitions) {
      errors.push(`No transitions defined for state ${run.status}`);
      return { valid: false, errors };
    }

    const transition = availableTransitions.find(t => t.command === command.type);
    if (!transition) {
      errors.push(`No transition found from ${run.status} with command ${command.type}`);
      errors.push(`Available commands: ${availableTransitions.map(t => t.command).join(', ')}`);
      return { valid: false, errors };
    }

    // Validate invariants
    const invariantFailures = transition.invariants
      .map(inv => inv(run))
      .filter(result => !result);

    if (invariantFailures.length > 0) {
      errors.push(`Invariant violations for transition ${command.type} from ${run.status}`);
    }

    // Validate strategy compatibility
    if (!STRATEGY_RULES[run.strategy](run)) {
      errors.push(`Strategy ${run.strategy} not compatible with current state ${run.status}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, definition: transition };
  }

  /**
   * Execute transition and return events
   */
  static applyTransition(
    run: TaskRun,
    command: Command,
    globalSequence: number
  ): { events: any[]; newVersion: number } {
    const validation = this.validateTransition(run, command);
    
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    // Create state transition event
    const transitionEvent = this.createTransitionEvent(
      run.aggregateId,
      run.version + 1,
      command,
      run.status,
      this.getTargetState(run, command.type),
      globalSequence
    );

    // Create strategy-specific events
    const strategyEvents = this.createStrategyEvents(run, command);

    return {
      events: [transitionEvent, ...strategyEvents],
      newVersion: run.version + 1
    };
  }

  private static getTargetState(run: TaskRun, commandType: string): TaskRunState {
    const transition = TRANSITION_MATRIX[run.status]?.find(t => t.command === commandType);
    if (!transition) {
      throw new Error(`No transition found for command ${commandType}`);
    }
    return transition.target;
  }

  private static createTransitionEvent(
    aggregateId: string,
    version: number,
    command: Command,
    fromState: TaskRunState,
    toState: TaskRunState,
    globalSequence: number
  ) {
    return {
      id: this.generateEventId(),
      aggregateId,
      aggregateVersion: version,
      globalSequence,
      type: 'TaskRunStateChanged',
      payloadVersion: '1.0',
      payload: {
        fromState,
        toState,
        command: command.type
      },
      causationId: command.causationId || command.commandId,
      correlationId: command.correlationId,
      commandId: command.commandId,
      createdAt: new Date(),
      createdAtTs: Date.now()
    };
  }

  private static createStrategyEvents(run: TaskRun, command: Command): any[] {
    const events: any[] = [];

    switch (run.strategy) {
      case 'planned':
        if (command.type === 'StartPlanningCommand') {
          events.push(this.createPlanningStartedEvent(run, command));
        }
        break;
      case 'delegated':
        if (command.type === 'DelegateToAgentCommand') {
          events.push(this.createDelegationStartedEvent(run, command));
        }
        break;
      case 'recovery':
        if (command.type === 'InitiateRecoveryCommand') {
          events.push(this.createRecoveryStartedEvent(run, command));
        }
        break;
    }

    return events;
  }

  private static createPlanningStartedEvent(run: TaskRun, command: Command) {
    return {
      id: this.generateEventId(),
      aggregateId: run.aggregateId,
      aggregateVersion: run.version + 1,
      globalSequence: 0, // To be assigned by event store
      type: 'PlanningStarted',
      payloadVersion: '1.0',
      payload: {
        planScope: run.planScope
      },
      causationId: command.causationId || command.commandId,
      correlationId: command.correlationId,
      commandId: command.commandId,
      createdAt: new Date(),
      createdAtTs: Date.now()
    };
  }

  private static createDelegationStartedEvent(run: TaskRun, command: Command) {
    return {
      id: this.generateEventId(),
      aggregateId: run.aggregateId,
      aggregateVersion: run.version + 1,
      globalSequence: 0,
      type: 'DelegationStarted',
      payloadVersion: '1.0',
      payload: {
        delegatedTo: run.delegationTarget,
        delegationMode: run.delegationMode
      },
      causationId: command.causationId || command.commandId,
      correlationId: command.correlationId,
      commandId: command.commandId,
      createdAt: new Date(),
      createdAtTs: Date.now()
    };
  }

  private static createRecoveryStartedEvent(run: TaskRun, command: Command) {
    return {
      id: this.generateEventId(),
      aggregateId: run.aggregateId,
      aggregateVersion: run.version + 1,
      globalSequence: 0,
      type: 'RecoveryStarted',
      payloadVersion: '1.0',
      payload: {
        recoveryPath: run.recoveryPath,
        failedStage: run.failedStage
      },
      causationId: command.causationId || command.commandId,
      correlationId: command.correlationId,
      commandId: command.commandId,
      createdAt: new Date(),
      createdAtTs: Date.now()
    };
  }

  private static generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Re-export types and constants
export { TRANSITION_MATRIX, STRATEGY_RULES, TERMINAL_STATES } from './task-run.js';

