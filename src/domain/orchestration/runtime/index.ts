/**
 * Runtime Domain - Phase 3A/3B
 * 
 * Exports TaskRun aggregate, entities, repositories, and event store
 */

// Core types (Phase 3A)
export { TaskRun, TaskRunState, TaskRunStrategy } from './task-run';
export { TRANSITION_MATRIX, STRATEGY_RULES, TERMINAL_STATES } from './task-run';
export { TransitionProcessor } from './domain-service.js';

// Entities
export type { Assignment } from './assignment.js';
export { AssignmentConsistencyValidator } from './assignment.js';
export type { Session } from './session';
export const SessionValidator = {} as any;
export const WorktreeManager = {} as any;
export type { ContextItem } from './context-item';
export { ContextConsistencyValidator } from './context-item';
export type { RuntimeRequirement } from './runtime-requirement.js';
export type { AcceptanceCriterionState } from './acceptance-criterion-state.js';

// Repositories (Phase 3A)
export { TaskRunRepository, AssignmentRepository, SessionRepository, ContextItemRepository } from './ports.js';
export {
  InMemoryTaskRunRepository,
  InMemoryAssignmentRepository,
  InMemorySessionRepository,
  InMemoryContextItemRepository,
  InMemoryWorktreeOwnershipRepository
} from './in-memory-repositories.js';

// Event Store (Phase 3B)
export * as RuntimeEvents from './event-store/index.js';

// Worktree Leases (Phase 3B)
export { InMemoryWorktreeLeaseRepository, type Lease } from './worktree-leases.js';
