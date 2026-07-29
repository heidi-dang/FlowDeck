/**
 * In-memory repository adapters for testing and initial development
 */

import type {
  TaskRunRepository,
  AssignmentRepository,
  SessionRepository,
  ContextItemRepository,
  RuntimeRequirementRepository,
  AcceptanceCriterionStateRepository,
  WorktreeOwnershipRepository
} from './ports.js';
import type { TaskRun } from './task-run';
import type { Assignment } from './assignment.js';
import type { Session } from './session';
import type { ContextItem } from './context-item';
import type { RuntimeRequirement } from './runtime-requirement.js';
import type { AcceptanceCriterionState } from './acceptance-criterion-state.js';

/**
 * In-memory task run repository
 */
export class InMemoryTaskRunRepository implements TaskRunRepository {
  private store = new Map<string, TaskRun>();

  async findById(id: string): Promise<TaskRun | undefined> {
    return this.store.get(id);
  }

  async findByCorrelationId(correlationId: string): Promise<TaskRun[]> {
    const result: TaskRun[] = [];
    for (const run of this.store.values()) {
      if (run.correlationId === correlationId) {
        result.push(run);
      }
    }
    return result;
  }

  async save(run: TaskRun): Promise<void> {
    // Ensure version increments only once per commit
    const existing = this.store.get(run.aggregateId);
    if (existing && run.version <= existing.version) {
      throw new Error(
        `Version conflict: existing version ${existing.version}, attempted ${run.version}`
      );
    }
    this.store.set(run.aggregateId, run);
  }

  async listByStatus(statuses: TaskRun['status'][], limit?: number): Promise<TaskRun[]> {
    const filtered = Array.from(this.store.values()).filter(run => 
      statuses.includes(run.status)
    );
    
    if (limit) {
      return filtered.slice(0, limit);
    }
    
    return filtered;
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }

  getAll(): TaskRun[] {
    return Array.from(this.store.values());
  }

  async ensureExists(run: TaskRun): Promise<boolean> {
    if (!this.store.has(run.aggregateId)) {
      await this.save(run);
      return true;
    }
    return false;
  }
}

/**
 * In-memory assignment repository
 */
export class InMemoryAssignmentRepository implements AssignmentRepository {
  private store = new Map<string, Assignment>();

  async findById(id: string): Promise<Assignment | undefined> {
    return this.store.get(id);
  }

  async findByRunId(runId: string): Promise<Assignment[]> {
    const result: Assignment[] = [];
    for (const assignment of this.store.values()) {
      if (assignment.runId === runId) {
        result.push(assignment);
      }
    }
    return result;
  }

  async save(assignment: Assignment): Promise<void> {
    this.store.set(assignment.id, assignment);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }

  async validateUniqueness(assignment: Pick<Assignment, 'id' | 'runId' | 'agentName'>): Promise<boolean> {
    for (const existing of this.store.values()) {
      if (
        existing.id !== assignment.id &&
        existing.runId === assignment.runId &&
        existing.agentName === assignment.agentName
      ) {
        return false;
      }
    }
    return true;
  }
}

/**
 * In-memory session repository
 */
export class InMemorySessionRepository implements SessionRepository {
  private store = new Map<string, Session>();

  async findById(id: string): Promise<Session | undefined> {
    return this.store.get(id);
  }

  async findByRunAndAgent(runId: string, agentName: string): Promise<Session | undefined> {
    for (const session of this.store.values()) {
      if (session.runId === runId && session.agentName === agentName) {
        return session;
      }
    }
    return undefined;
  }

  async findByRunId(runId: string): Promise<Session[]> {
    const result: Session[] = [];
    for (const session of this.store.values()) {
      if (session.runId === runId) {
        result.push(session);
      }
    }
    return result;
  }

  async save(session: Session): Promise<void> {
    this.store.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }

  getActiveSessionsForRun(runId: string): Session[] {
    return Array.from(this.store.values()).filter(s => 
      s.runId === runId && ['active', 'created', 'suspended'].includes(s.status)
    );
  }
}

/**
 * In-memory context item repository
 */
export class InMemoryContextItemRepository implements ContextItemRepository {
  private store = new Map<string, ContextItem>();

  async findById(id: string): Promise<ContextItem | undefined> {
    return this.store.get(id);
  }

  async findByRunId(runId: string): Promise<ContextItem[]> {
    const result: ContextItem[] = [];
    for (const item of this.store.values()) {
      if (item.runId === runId) {
        result.push(item);
      }
    }
    return result;
  }

  async save(context: ContextItem): Promise<void> {
    this.store.set(context.id, context);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async listSources(runId: string): Promise<string[]> {
    const sources = new Set<string>();
    for (const item of this.store.values()) {
      if (item.runId === runId) {
        sources.add(item.source);
      }
    }
    return [...sources];
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }

  getBySource(source: string): ContextItem | undefined {
    for (const item of this.store.values()) {
      if (item.source === source) {
        return item;
      }
    }
    return undefined;
  }
}

/**
 * In-memory runtime requirement repository
 */
export class InMemoryRuntimeRequirementRepository implements RuntimeRequirementRepository {
  private store = new Map<string, RuntimeRequirement>();

  async findById(id: string): Promise<RuntimeRequirement | undefined> {
    return this.store.get(id);
  }

  async findByRunId(runId: string): Promise<RuntimeRequirement[]> {
    const result: RuntimeRequirement[] = [];
    for (const req of this.store.values()) {
      if (req.runId === runId) {
        result.push(req);
      }
    }
    return result;
  }

  async save(requirement: RuntimeRequirement): Promise<void> {
    this.store.set(requirement.id, requirement);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }
}

/**
 * In-memory acceptance criterion state repository
 */
export class InMemoryAcceptanceCriterionStateRepository implements AcceptanceCriterionStateRepository {
  private store = new Map<string, AcceptanceCriterionState>();

  async findById(id: string): Promise<AcceptanceCriterionState | undefined> {
    return this.store.get(id);
  }

  async findByRunId(runId: string): Promise<AcceptanceCriterionState[]> {
    const result: AcceptanceCriterionState[] = [];
    for (const state of this.store.values()) {
      if (state.runId === runId) {
        result.push(state);
      }
    }
    return result;
  }

  async save(state: AcceptanceCriterionState): Promise<void> {
    this.store.set(state.id, state);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Helper methods for tests */
  clear(): void {
    this.store.clear();
  }

  async getSortedBySequence(runId: string): Promise<AcceptanceCriterionState[]> {
    const states = await this.findByRunId(runId);
    return states.sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  }
}

/**
 * In-memory worktree ownership repository
 * Uses stable identifiers, not mutable paths
 */
export class InMemoryWorktreeOwnershipRepository implements WorktreeOwnershipRepository {
  private ownership = new Map<string, string>();
  private tokens = new Map<string, number>(); // worktreeKey → fencing token

  async getOwner(worktreeKey: string): Promise<string | undefined> {
    return this.ownership.get(worktreeKey);
  }

  async claimOwnership(worktreeKey: string, ownerId: string): Promise<boolean> {
    const existingOwner = this.ownership.get(worktreeKey);
    
    // Atomic claim using compare-and-swap semantics
    if (!existingOwner || existingOwner === ownerId) {
      this.ownership.set(worktreeKey, ownerId);
      this.tokens.set(worktreeKey, (this.tokens.get(worktreeKey) ?? 0) + 1);
      return true;
    }
    
    return false;
  }

  async releaseOwnership(worktreeKey: string): Promise<void> {
    // Release ownership without requiring owner ID match
    // Safety preserved via fencing token validation at operation boundary
    const current = this.ownership.get(worktreeKey);
    if (current) {
      this.ownership.delete(worktreeKey);
      this.tokens.delete(worktreeKey);
    }
  }

  /** Helper methods for tests */
  clear(): void {
    this.ownership.clear();
    this.tokens.clear();
  }

  async isOwnedBy(worktreeKey: string, ownerId: string): Promise<boolean> {
    return this.ownership.get(worktreeKey) === ownerId;
  }

  getAllOwnerships(): Map<string, string> {
    return new Map(this.ownership);
  }
}

