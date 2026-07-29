/**
 * Repository ports for runtime domain
 * These interfaces define the contract between orchestration runtime and persistence
 */

import type { TaskRun } from './task-run.js';

// Inline type definitions for cross-file dependencies
export interface Assignment {
  readonly id: string;
  readonly runId: string;
  readonly agentName: string;
  readonly title: string;
  readonly status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'waiting-for-input';
  readonly priority: 'low' | 'medium' | 'high' | 'urgent';
}

export interface Session {
  readonly id: string;
  readonly runId: string;
  readonly agentName: string;
  readonly title: string;
  readonly status: 'created' | 'active' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  readonly mode: 'planning' | 'analysis' | 'execution' | 'verification' | 'recovery' | 'audit';
}

export interface ContextItem {
  readonly id: string;
  readonly runId: string;
  readonly source: string;
  readonly status: 'pending' | 'active' | 'archived' | 'superseded' | 'deleted';
}

export interface RuntimeRequirement {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: 'pending' | 'in-progress' | 'validated' | 'failed' | 'skipped';
}

export interface AcceptanceCriterionState {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: 'pending' | 'passing' | 'failing' | 'blocked' | 'skipped';
}

/**
 * Unit of work coordinator
 * Tracks changes and coordinates commits across repositories
 */
export interface UnitOfWork {
  /** Register aggregate for commit */
  register(aggregate: { getId(): string; getUncommittedEvents(): any[] }): void;
  
  /** Commit all registered changes atomically */
  commit(): Promise<void>;
  
  /** Rollback all pending changes */
  rollback(): void;
}

/**
 * Clock abstraction for testable time operations
 */
export interface Clock {
  now(): Date;
  nowTs(): number;
}

/**
 * ID generator for stable identifiers
 */
export interface IdGenerator {
  generate(): string;
}

/**
 * Task run repository port
 * Coordinates with EventStore via unit of work
 */
export interface TaskRunRepository {
  /** Find run by ID */
  findById(id: string): Promise<TaskRun | undefined>;
  
  /** Find by correlation ID for cross-run lookups */
  findByCorrelationId(correlationId: string): Promise<TaskRun[]>;
  
  /** Save run (delegates to event store via UoW) */
  save(run: TaskRun): Promise<void>;
  
  /** List runs by status */
  listByStatus(statuses: TaskRun['status'][], limit?: number): Promise<TaskRun[]>;
}

/**
 * Assignment repository port
 * Ensures assignments belong to valid runs
 */
export interface AssignmentRepository {
  /** Find assignment by ID */
  findById(id: string): Promise<Pick<Assignment, 'id' | 'runId'> | undefined>;
  
  /** Find all assignments for a run */
  findByRunId(runId: string): Promise<Assignment[]>;
  
  /** Save assignment (validates run ownership) */
  save(assignment: Assignment): Promise<void>;
  
  /** Delete assignment */
  delete(id: string): Promise<void>;
}

/**
 * Session repository port
 * Ensures sessions belong to valid runs
 */
export interface SessionRepository {
  /** Find session by ID */
  findById(id: string): Promise<Session | undefined>;
  
  /** Find session by run and agent */
  findByRunAndAgent(runId: string, agentName: string): Promise<Session | undefined>;
  
  /** Find all sessions for a run */
  findByRunId(runId: string): Promise<Session[]>;
  
  /** Save session (validates run ownership) */
  save(session: Session): Promise<void>;
  
  /** Delete session */
  delete(id: string): Promise<void>;
}

/**
 * Context item repository port
 * Ensures context belongs to valid runs
 */
export interface ContextItemRepository {
  /** Find context by ID */
  findById(id: string): Promise<ContextItem | undefined>;
  
  /** Find all context for a run */
  findByRunId(runId: string): Promise<ContextItem[]>;
  
  /** Save context (validates run ownership) */
  save(context: ContextItem): Promise<void>;
  
  /** Delete context */
  delete(id: string): Promise<void>;
  
  /** List unique sources for a run */
  listSources(runId: string): Promise<string[]>;
}

/**
 * Runtime requirement repository port
 */
export interface RuntimeRequirementRepository {
  /** Find requirement by ID */
  findById(id: string): Promise<RuntimeRequirement | undefined>;
  
  /** Find requirements for a run */
  findByRunId(runId: string): Promise<RuntimeRequirement[]>;
  
  /** Save requirement */
  save(requirement: RuntimeRequirement): Promise<void>;
  
  /** Delete requirement */
  delete(id: string): Promise<void>;
}

/**
 * Acceptance criterion state repository port
 */
export interface AcceptanceCriterionStateRepository {
  /** Find state by ID */
  findById(id: string): Promise<AcceptanceCriterionState | undefined>;
  
  /** Find states for a run */
  findByRunId(runId: string): Promise<AcceptanceCriterionState[]>;
  
  /** Save state */
  save(state: AcceptanceCriterionState): Promise<void>;
  
  /** Delete state */
  delete(id: string): Promise<void>;
}

/**
 * Worktree ownership tracker
 * Stable identity based on storage path, not mutable filesystem paths
 */
export interface WorktreeOwnershipRepository {
  /** Get owner for worktree key */
  getOwner(worktreeKey: string): Promise<string | undefined>;
  
  /** Claim ownership (atomic) */
  claimOwnership(worktreeKey: string, ownerId: string): Promise<boolean>;
  
  /** Release ownership */
  releaseOwnership(worktreeKey: string): Promise<void>;
  
  /** Check if owned by specific owner */
  isOwnedBy(worktreeKey: string, ownerId: string): Promise<boolean>;
}
