/**
 * Session entity - represents agent conversation/work sessions within a run
 * 
 * Invariants:
 * - Must belong to valid run
 * - Cannot span multiple runs
 * - One session per agent per run (unless explicitly allowed)
 * - Sessions must follow run state lifecycle
 */

import type { TaskRun, TaskRunState } from './task-run.js';

/**
 * Session status
 */
export type SessionStatus = 
  | 'created'
  | 'active'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Session mode
 */
export type SessionMode = 
  | 'planning'
  | 'analysis'
  | 'execution'
  | 'verification'
  | 'recovery'
  | 'audit';

/**
 * Session entity
 */
export interface Session {
  readonly id: string;
  readonly runId: string; // Foreign key - must exist
  readonly agentName: string; // e.g., "architect", "coder"
  readonly title: string;
  readonly description?: string;
  readonly status: SessionStatus;
  readonly mode: SessionMode;
  readonly parentId?: string; // For parent-child session hierarchy
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt?: Date;
  readonly suspendedAt?: Date;
  readonly resumedAt?: Date;
  readonly completedAt?: Date;
  readonly failedAt?: Date;
  readonly cancelledAt?: Date;
  
  // Runtime context
  readonly messageCount?: number;
  readonly tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  
  readonly lastMessageAt?: Date;
  readonly contextSnapshot?: {
    step: number;
    state: unknown;
    memory: unknown;
  };
}

/**
 * Session creation options
 */
export interface CreateSessionOptions {
  runId: string;
  agentName: string;
  title: string;
  description?: string;
  mode: SessionMode;
  parentId?: string;
}

/**
 * Session update operations
 */
export interface SessionUpdate {
  status?: SessionStatus;
  mode?: SessionMode;
  parentId?: string | null;
  startedAt?: Date;
  suspendedAt?: Date;
  resumedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  messageCount?: number;
  tokenUsage?: Session['tokenUsage'];
  lastMessageAt?: Date;
  contextSnapshot?: Session['contextSnapshot'];
}

/**
 * Session consistency validator
 * Ensures sessions cannot violate run boundaries
 */
export class SessionConsistencyValidator {
  /**
   * Validate session belongs to existing run
   */
  static validateRunOwnership(
    session: Pick<Session, 'id' | 'runId'>,
    run: TaskRun | undefined
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (!run) {
      errors.push(`Session ${session.id} references non-existent run ${session.runId}`);
      return { valid: false, errors };
    }

    // Check session mode compatibility with run state
    const modeCompatibility = this.validateModeCompatibility(
      run.status,
      (session as Session).mode || 'planning'
    );
    if (!modeCompatibility.valid) {
      errors.push(...modeCompatibility.errors);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Ensure unique session per run + agent (with optional override for multi-threaded agents)
   */
  static validateUniqueness(
    session: Pick<Session, 'runId' | 'agentName' | 'id' | 'mode'>,
    existingSessions: Session[],
    allowConcurrent: boolean = false
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    const activeSession = existingSessions.find(s => 
      s.runId === session.runId && 
      s.agentName === session.agentName &&
      s.id !== session.id && // Allow self-reference for updates
      !allowConcurrent && // Skip check if concurrent sessions allowed
      ['active', 'created', 'suspended'].includes(s.status)
    );

    if (activeSession) {
      errors.push(
        `Active session already exists for run ${session.runId} and agent ${session.agentName}. ` +
        `${allowConcurrent ? '' : 'Set allowConcurrent=true if multiple concurrent sessions are expected.'}`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Ensure no cross-run sessions
   */
  static validateNoCrossRunDependencies(
    session: Session,
    parentSession: Session | undefined,
    runSessions: Session[]
  ): { valid: true } | { valid: false; errors: string[] } {
    const rootRunId = session.runId;
    const errors: string[] = [];

    if (parentSession && parentSession.runId !== session.runId) {
      errors.push(
        `Parent session ${parentSession.id} belongs to different run ${parentSession.runId}. ` +
        `Sessions cannot span multiple runs.`
      );
    }

    // Verify hierarchical depth doesn't exceed reasonable bounds
    if (this.hasExcessiveHierarchy(session, rootRunId, runSessions)) {
      errors.push(`Session hierarchy exceeds maximum depth for run ${session.runId}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Validate session mode is compatible with run state
   */
  static validateModeCompatibility(
    runState: TaskRunState,
    sessionMode: SessionMode
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    const compatibilities: Record<TaskRunState, SessionMode[]> = {
      created: ['planning'],
      planning: ['planning'],
      analysing: ['analysis'],
      delegating: ['execution', 'audit'],
      executing: ['execution'],
      verifying: ['verification', 'audit'],
      recovering: ['recovery', 'audit'],
      completed: [],
      failed: [],
      cancelled: []
    };

    const allowedModes = compatibilities[runState];
    if (!allowedModes || !allowedModes.includes(sessionMode)) {
      errors.push(
        `Session mode ${sessionMode} not compatible with run state ${runState}. ` +
        `Allowed modes: ${allowedModes.join(', ') || 'none in terminal state'}`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  private static hasExcessiveHierarchy(
    session: Session,
    rootRunId: string,
    allSessions: Session[],
    depth = 0,
    maxDepth = 10
  ): boolean {
    if (depth > maxDepth) {
      return true;
    }

    if (!session.parentId) {
      return false;
    }

    const parent = allSessions.find(s => s.id === session.parentId);
    if (!parent) {
      return false; // Orphan reference - should be caught elsewhere
    }

    // Cross-run check at any level
    if (parent.runId !== rootRunId) {
      return true;
    }

    return this.hasExcessiveHierarchy(parent, rootRunId, allSessions, depth + 1, maxDepth);
  }
}

