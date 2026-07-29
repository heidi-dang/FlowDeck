/**
 * Assignment entity - represents agent/developer task assignments within a run
 * 
 * Invariants:
 * - Must belong to valid run
 * - Cannot span multiple runs
 * - Assignment must be unique per run + agent combination
 */

import type { TaskRun } from './task-run.js';

/**
 * Assignment status
 */
export type AssignmentStatus = 
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting-for-input';

/**
 * Assignment priority
 */
export type AssignmentPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Assignment entity
 */
export interface Assignment {
  readonly id: string;
  readonly runId: string; // Foreign key - must exist
  readonly agentName: string; // e.g., "architect", "coder", "reviewer"
  readonly title: string;
  readonly description?: string;
  readonly status: AssignmentStatus;
  readonly priority: AssignmentPriority;
  readonly parentId?: string; // For nested tasks
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly failedAt?: Date;
  readonly cancelledAt?: Date;
  
  // Runtime tracking
  readonly tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  
  readonly errorDetails?: {
    message: string;
    code?: string;
    stackTrace?: string;
  };
}

/**
 * Assignment creation options
 */
export interface CreateAssignmentOptions {
  runId: string;
  agentName: string;
  title: string;
  description?: string;
  priority?: AssignmentPriority;
  parentId?: string;
}

/**
 * Assignment update operations
 */
export interface AssignmentUpdate {
  status?: AssignmentStatus;
  priority?: AssignmentPriority;
  parentId?: string | null;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  errorDetails?: Assignment['errorDetails'];
  tokenUsage?: Assignment['tokenUsage'];
}

/**
 * Assignment consistency validator
 * Ensures assignments cannot violate run boundaries
 */
export class AssignmentConsistencyValidator {
  /**
   * Validate assignment belongs to existing run
   */
  static validateRunOwnership(
    assignment: Pick<Assignment, 'id' | 'runId'>,
    run: TaskRun | undefined
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (!run) {
      errors.push(`Assignment ${assignment.id} references non-existent run ${assignment.runId}`);
      return { valid: false, errors };
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      errors.push(`Cannot assign tasks to run ${assignment.runId} in terminal state ${run.status}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Ensure unique assignment per run + agent
   */
  static validateUniqueness(
    assignment: Pick<Assignment, 'id' | 'runId' | 'agentName'>,
    existingAssignments: Assignment[]
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    const duplicate = existingAssignments.find(a => 
      a.runId === assignment.runId && 
      a.agentName === assignment.agentName &&
      a.id !== assignment.id // Allow self-reference for updates
    );

    if (duplicate) {
      errors.push(`Duplicate assignment found for run ${assignment.runId} and agent ${assignment.agentName}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Ensure no cross-run assignments
   */
  static validateNoCrossRunDependencies(
    assignment: Assignment,
    parentAssignment: Assignment | undefined,
    runAssignments: Assignment[]
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (parentAssignment && parentAssignment.runId !== assignment.runId) {
      errors.push(
        `Parent assignment ${parentAssignment.id} belongs to different run ${parentAssignment.runId}. ` +
        `Assignments cannot span multiple runs.`
      );
    }

    // Check for circular dependencies within same run
    if (parentAssignment && this.hasCircularDependency(parentAssignment, assignment.runId, runAssignments)) {
      errors.push(`Circular dependency detected in assignments for run ${assignment.runId}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  private static hasCircularDependency(
    assignment: Assignment,
    rootRunId: string,
    allAssignments: Assignment[],
    visited = new Set<string>()
  ): boolean {
    if (visited.has(assignment.id)) {
      return true;
    }

    visited.add(assignment.id);

    if (assignment.parentId) {
      const parent = allAssignments.find(a => a.id === assignment.parentId);
      if (parent && parent.runId !== rootRunId) {
        return true; // Cross-run reference
      }
      if (parent?.parentId) {
        return this.hasCircularDependency(parent, rootRunId, allAssignments, visited);
      }
    }

    return false;
  }
}

