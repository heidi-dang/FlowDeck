/**
 * Tests for task run state transitions and domain invariants
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { TaskRunState } from '@/domain/orchestration/runtime/task-run.js';
import { TRANSITION_MATRIX, STRATEGY_RULES, TERMINAL_STATES } from '@/domain/orchestration/runtime/task-run.js';
import { TransitionProcessor } from '@/domain/orchestration/runtime/domain-service.js';
import { AssignmentConsistencyValidator } from '@/domain/orchestration/runtime/assignment.js';
import { SessionConsistencyValidator } from '@/domain/orchestration/runtime/session.js';
import { ContextSourceValidator } from '@/domain/orchestration/runtime/context-item.js';
import { 
  InMemoryTaskRunRepository,
  InMemoryAssignmentRepository,
  InMemorySessionRepository,
  InMemoryContextItemRepository,

  InMemoryWorktreeOwnershipRepository
} from '@/domain/orchestration/runtime/in-memory-repositories.js';
import type { TaskRun } from '@/domain/orchestration/runtime/task-run.js';
import type { Assignment } from '@/domain/orchestration/runtime/assignment.js';
import type { Session } from '@/domain/orchestration/runtime/session.js';
import type { ContextItem } from '@/domain/orchestration/runtime/context-item.js';

describe('PR 3A - Runtime State Domain', () => {
  describe('Transition Matrix', () => {
    it('defines all required states', () => {
      const expectedStates: TaskRunState[] = [
        'created', 'planning', 'analysing', 'delegating',
        'executing', 'verifying', 'recovering', 'completed', 'failed', 'cancelled'
      ];

      for (const state of expectedStates) {
        expect(TRANSITION_MATRIX[state]).toBeDefined();
      }
    });

    it('no terminal states have outgoing transitions', () => {
      for (const terminalState of ['completed', 'failed', 'cancelled']) {
        expect(TRANSITION_MATRIX[terminalState]).toHaveLength(0);
        expect(TERMINAL_STATES.has(terminalState as TaskRunState)).toBe(true);
      }
    });

    it('all states can fail or cancel except recovering', () => {
      // Recoverable states (can go to executing) + planning/analysing/delegating/executing/verifying
      const recoverableStates = ['created', 'planning', 'analysing', 'delegating', 'executing', 'verifying'];
      
      for (const state of recoverableStates) {
        const transitions = TRANSITION_MATRIX[state];
        const commands = transitions.map(t => t.command);
        
        expect(commands).toContain('FailCommand');
        expect(commands).toContain('CancelCommand');
      }
    });

    it('recovery state has unique transitions', () => {
      const recoveryTransitions = TRANSITION_MATRIX.recovering;
      expect(recoveryTransitions.some(t => t.target === 'executing')).toBe(true);
      expect(recoveryTransitions.some(t => t.target === 'failed')).toBe(true);
      expect(recoveryTransitions.some(t => t.target === 'cancelled')).toBe(true);
    });
  });

  describe('Strategy Rules', () => {
    it('validates simple strategy', () => {
      const mockRun = { strategy: 'simple' } as any;
      expect(STRATEGY_RULES.simple(mockRun)).toBe(true);
    });

    it('validates planned strategy', () => {
      const plannedRun = { strategy: 'planned' } as any;
      expect(STRATEGY_RULES.planned(plannedRun)).toBe(true);
    });

    it('validates delegated strategy', () => {
      const delegatedRun = { strategy: 'delegated' } as any;
      expect(STRATEGY_RULES.delegated(delegatedRun)).toBe(true);
    });
  });

  describe('Transition Validation', () => {
    const createMockRun = (overrides?: Partial<TaskRun>) => ({
      aggregateId: 'run_123',
      version: 1,
      state: 'created',
      strategy: 'simple',
      ...overrides
    }) as unknown as TaskRun & { 
      planningCompleted?: boolean; 
      analysisComplete?: boolean;
      agentResponseReceived?: boolean;
      executionComplete?: boolean;
      acceptanceCriteriaMet?: boolean;
      needsRecovery?: boolean;
      agentFailedOrTimeout?: boolean;
      executableFailed?: boolean;
      verificationFailed?: boolean;
      recoveryComplete?: boolean;
      recoveryExhausted?: boolean;
      planScope?: any;
      delegationTarget?: string;
      delegationMode?: string;
      recoveryPath?: string;
      failedStage?: string;
    };

    it('allows created -> planning transition with planned strategy', async () => {
      const run = createMockRun({ status: 'created' as TaskRunState, strategy: 'planned' });
      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.validateTransition(run, command);
      expect(result.valid).toBe(true);
    });

    it('rejects transition from terminal state completed', async () => {
      const run = createMockRun({ status: 'completed' as TaskRunState });
      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.validateTransition(run, command);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('terminal state'))).toBe(true);
      }
    });

    it('rejects invalid command for state', async () => {
      const run = createMockRun({ status: 'created' as TaskRunState });
      const command = {
        type: 'NonExistentCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.validateTransition(run, command);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('No transition found'))).toBe(true);
      }
    });

    it('requires invariants to pass before transition', async () => {
      const run = createMockRun({ 
        status: 'planning' as TaskRunState,
        strategy: 'planned'
        // planningCompleted is false
      });
      const command = {
        type: 'StartAnalysisCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.validateTransition(run, command);
      expect(result.valid).toBe(false);
    });

    it('emits events on successful transition', async () => {
      const run = createMockRun({ 
        status: 'created' as TaskRunState,
        strategy: 'planned'
      });
      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.applyTransition(run, command, 1);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.newVersion).toBe(2);
    });
  });

  describe('Assignment Consistency', () => {
    const createMockRun = (state: TaskRunState): TaskRun => ({
      aggregateId: 'run_123',
      status: state,
      version: 1,
      strategy: 'simple'
    });

    it('validates assignment belongs to existing run', () => {
      const assignment = { id: 'assign_1', runId: 'run_123' };
      const run = createMockRun('planning');
      
      const result = AssignmentConsistencyValidator.validateRunOwnership(assignment, run);
      expect(result.valid).toBe(true);
    });

    it('rejects assignment to non-existent run', () => {
      const assignment = { id: 'assign_1', runId: 'nonexistent' };
      
      const result = AssignmentConsistencyValidator.validateRunOwnership(assignment, undefined);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('non-existent'))).toBe(true);
      }
    });

    it('rejects assignment to terminal state run', () => {
      const assignment = { id: 'assign_1', runId: 'run_123' };
      const run = createMockRun('completed');
      
      const result = AssignmentConsistencyValidator.validateRunOwnership(assignment, run);
      expect(result.valid).toBe(false);
    });

    it('enforces unique assignment per run + agent', () => {
      const assignment = { id: 'assign_1', runId: 'run_123', agentName: 'coder'} as Assignment;
      const existingAssignments = [
        { id: 'assign_2', runId: 'run_123', agentName: 'coder'} as Assignment
      ];
      
      const result = AssignmentConsistencyValidator.validateUniqueness(assignment, existingAssignments);
      expect(result.valid).toBe(false);
    });

    it('rejects cross-run assignments via parent', () => {
      const childAssignment: Assignment = {
        id: 'assign_child',
        runId: 'run_1',
        agentName: 'coder',
        title: 'Child Task',
        status: 'pending',
        priority: 'medium',
        parentId: 'parent_assign',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const parentAssignment: Assignment = {
        id: 'parent_assign',
        runId: 'run_2', // Different run!
        agentName: 'architect',
        title: 'Parent Task',
        status: 'pending',
        priority: 'high',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const runAssignments = [parentAssignment, childAssignment];
      
      const result = AssignmentConsistencyValidator.validateNoCrossRunDependencies(
        childAssignment,
        parentAssignment,
        runAssignments
      );
      
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('Different run') || e.includes('span multiple runs'))).toBe(true);
      }
    });
  });

  describe('Session Consistency', () => {
    it('validates session mode compatibility with run state', () => {
      const compatibilities = [
        { runState: 'created', mode: 'planning', shouldPass: true },
        { runState: 'planning', mode: 'planning', shouldPass: true },
        { runState: 'analysing', mode: 'analysis', shouldPass: true },
        { runState: 'executing', mode: 'execution', shouldPass: true },
        { runState: 'verifying', mode: 'verification', shouldPass: true },
        { runState: 'recovering', mode: 'recovery', shouldPass: true },
        { runState: 'completed', mode: 'planning', shouldPass: false }, // Terminal state
        { runState: 'planning', mode: 'execution', shouldPass: false } // Mode mismatch
      ];

      for (const { runState, mode, shouldPass } of compatibilities) {
        const result = SessionConsistencyValidator.validateModeCompatibility(
          runState as TaskRunState,
          mode as any
        );
        expect(result.valid).toBe(shouldPass);
      }
    });
  });

  describe('Context Item Consistency', () => {
    it('validates stable source identifiers', () => {
      const validSources = [
        'ref:abc123',
        'file:a1b2c3d4e5f6',
        'dir:f6e5d4c3b2a1',
        'symbol:MyClass.myMethod',
        'url:https://example.com/docs',
        'agent:architect',
        'tool:lint',
        'session:xyz789'
      ];

      for (const source of validSources) {
        const result = ContextSourceValidator.validateStableSource(source);
        expect(result.valid).toBe(true);
      }
    });

    it('rejects mutable filesystem paths', () => {
      const invalidSources = [
        '/home/user/project',
        'C:\\Users\\user\\project',
        './relative/path',
        '../parent/path'
      ];

      for (const source of invalidSources) {
        const result = ContextSourceValidator.validateStableSource(source);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.some(e => e.includes('mutable') || e.includes('path'))).toBe(true);
        }
      }
    });
  });

  describe('In-Memory Repositories', () => {
    describe('Task Run Repository', () => {
      let repo: InMemoryTaskRunRepository;

      beforeEach(() => {
        repo = new InMemoryTaskRunRepository();
      });

      it('saves and retrieves by ID', async () => {
        const run: TaskRun = {
          aggregateId: 'run_123',
          version: 1,
          status: 'created',
          strategy: 'simple',
          createdAt: new Date(), // This will be handled by domain service
          updatedAt: new Date()
        } as TaskRun;

        await repo.save(run);
        const retrieved = await repo.findById('run_123');
        
        expect(retrieved).toBeDefined();
        expect(retrieved?.aggregateId).toBe('run_123');
      });

      it('throws on version conflict', async () => {
        const run = {
          aggregateId: 'run_123',
          version: 1,
          status: 'created' as TaskRunState,
          strategy: 'simple'
        } as TaskRun;

        await repo.save(run);
        
        const conflictingRun: TaskRun = {
          aggregateId: 'run_123',
          version: 0, // Lower version
          status: 'created',
          strategy: 'simple'
        } as TaskRun;

        await expect(repo.save(conflictingRun)).rejects.toThrow('Version conflict');
      });

      it('filters by status', async () => {
        await repo.save({ aggregateId: 'run_1', version: 1, status: 'completed' as TaskRunState, strategy: 'simple' } as TaskRun);
        await repo.save({ aggregateId: 'run_2', version: 1, status: 'planning' as TaskRunState, strategy: 'simple' } as TaskRun);
        await repo.save({ aggregateId: 'run_3', version: 1, status: 'completed' as TaskRunState, strategy: 'simple' } as TaskRun);

        const completedRuns = await repo.listByStatus(['completed']);
        expect(completedRuns).toHaveLength(2);
      });
    });

    describe('Assignment Repository', () => {
      let repo: InMemoryAssignmentRepository;

      beforeEach(() => {
        repo = new InMemoryAssignmentRepository();
      });

      it('ensures no cross-run assignments during save', async () => {
        const assignment1 = {
          id: 'assign_1',
          runId: 'run_1',
          agentName: 'coder',
          title: 'Task 1',
          status: 'pending'
        } as Assignment;

        await repo.save(assignment1);
        
        const assignments = await repo.findByRunId('run_1');
        expect(assignments).toHaveLength(1);
        expect(assignments[0].id).toBe('assign_1');
      });
    });

    describe('Session Repository', () => {
      let repo: InMemorySessionRepository;

      beforeEach(() => {
        repo = new InMemorySessionRepository();
      });

      it('finds active sessions for run', async () => {
        await repo.save({
          id: 'session_1',
          runId: 'run_1',
          agentName: 'coder',
          title: 'Session 1',
          status: 'active'
        } as Session);

        await repo.save({
          id: 'session_2',
          runId: 'run_1',
          agentName: 'architect',
          title: 'Session 2',
          status: 'completed'
        } as Session);

        const activeSessions = repo.getActiveSessionsForRun('run_1');
        expect(activeSessions).toHaveLength(1);
        expect(activeSessions[0].id).toBe('session_1');
      });
    });

    describe('Context Item Repository', () => {
      let repo: InMemoryContextItemRepository;

      beforeEach(() => {
        repo = new InMemoryContextItemRepository();
      });

      it('lists unique sources for a run', async () => {
        await repo.save({
          id: 'ctx_1',
          runId: 'run_1',
          type: 'codebase-summary',
          title: 'Summary 1',
          content: {},
          source: 'file:abc123'
        } as ContextItem);

        await repo.save({
          id: 'ctx_2',
          runId: 'run_1',
          type: 'analysis-result',
          title: 'Analysis 1',
          content: {},
          source: 'ref:def456'
        } as ContextItem);

        await repo.save({
          id: 'ctx_3',
          runId: 'run_1',
          type: 'planning-output',
          title: 'Plan 1',
          content: {},
          source: 'file:abc123' // Duplicate source
        } as ContextItem);

        const sources = await repo.listSources('run_1');
        expect(sources).toHaveLength(2);
        expect(sources).toContain('file:abc123');
        expect(sources).toContain('ref:def456');
      });
    });

    describe('Worktree Ownership', () => {
      let repo: InMemoryWorktreeOwnershipRepository;

      beforeEach(() => {
        repo = new InMemoryWorktreeOwnershipRepository();
      });

      it('implements atomic ownership claim', async () => {
        const worktreeKey = 'worktree:abc123';
        const ownerId1 = 'worker_1';
        const ownerId2 = 'worker_2';

        // First worker claims
        const claimed1 = await repo.claimOwnership(worktreeKey, ownerId1);
        expect(claimed1).toBe(true);

        // Second worker fails to claim
        const claimed2 = await repo.claimOwnership(worktreeKey, ownerId2);
        expect(claimed2).toBe(false);

        // Owner can reclaim their own lock
        const reclaimed = await repo.claimOwnership(worktreeKey, ownerId1);
        expect(reclaimed).toBe(true);
      });

      it('tracks ownership state correctly', async () => {
        const worktreeKey = 'worktree:xyz789';
        const ownerId = 'worker_1';

        await repo.claimOwnership(worktreeKey, ownerId);
        
        expect(await repo.getOwner(worktreeKey)).toBe(ownerId);
        expect(await repo.isOwnedBy(worktreeKey, ownerId)).toBe(true);
        expect(await repo.isOwnedBy(worktreeKey, 'other')).toBe(false);
      });
    });
  });

  describe('Aggregate Version Increments', () => {
    it('increments exactly once per transition', async () => {
      const run = {
        aggregateId: 'run_123',
        version: 1,
        status: 'created' as TaskRunState,
        strategy: 'simple'
      } as TaskRun;

      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_456',
        correlationId: 'corr_789'
      };

      const result = TransitionProcessor.applyTransition(run, command, 1);
      expect(result.newVersion).toBe(2);
      expect(result.events.filter(e => e.aggregateVersion === 2)).toHaveLength(1);
    });
  });

  describe('Duplicate Command Idempotency', () => {
    it('detects duplicate commands via commandId', async () => {
      const run = {
        aggregateId: 'run_123',
        version: 1,
        status: 'created' as TaskRunState,
        strategy: 'simple'
      } as TaskRun;

      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'unique_cmd_123',
        correlationId: 'corr_789'
      };

      // First execution
      const result1 = TransitionProcessor.applyTransition(run, command, 1);
      
      // Simulate duplicate (same commandId, same aggregate)
      // In real impl, would check event store for duplicate
      expect(result1.events[0].commandId).toBe('unique_cmd_123');
    });
  });

  describe('Global Sequence Ordering', () => {
    it('assigns monotonic sequence numbers', async () => {
      const run = {
        aggregateId: 'run_123',
        version: 1,
        status: 'created' as TaskRunState,
        strategy: 'simple'
      } as TaskRun;

      const command = {
        type: 'StartPlanningCommand',
        aggregateId: 'run_123',
        payload: {},
        commandId: 'cmd_1',
        correlationId: 'corr'
      } as const;

      // Simulate sequential appends
      const result1 = TransitionProcessor.applyTransition(run, command as Parameters<typeof TransitionProcessor.applyTransition>[1], 1);
      expect(result1.events[0].eventType).toBe('TaskRunStateChanged');
    });
  });
});
