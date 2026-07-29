/**
 * Acceptance Criterion State entity - tracks state of acceptance criteria during execution
 */

import type { TaskRun } from './task-run.js';

/**
 * Acceptance criterion status
 */
export type AcceptanceStatus = 
  | 'pending'
  | 'passing'
  | 'failing'
  | 'blocked'
  | 'skipped';

/**
 * Acceptance criterion state entity
 */
export interface AcceptanceCriterionState {
  readonly id: string;
  readonly runId: string; // Foreign key - must exist
  readonly title: string;
  readonly description?: string;
  readonly status: AcceptanceStatus;
  readonly sequenceOrder: number; // Order in which criteria should be validated
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastCheckedAt?: Date;
  readonly blockedUntil?: Date;
  
  // Validation details
  readonly validationDetails?: {
    method: string;
    expected: unknown;
    actual: unknown;
    tolerance?: number;
  };
  
  // Failure analysis
  readonly failureAnalysis?: {
    cause: string;
    impact: 'critical' | 'high' | 'medium' | 'low';
    suggestedFix?: string;
  };
}

/**
 * Acceptance criterion state creation options
 */
export interface CreateAcceptanceCriterionOptions {
  runId: string;
  title: string;
  description?: string;
  sequenceOrder: number;
  status?: AcceptanceStatus;
}

/**
 * Acceptance criterion state update operations
 */
export interface AcceptanceCriterionUpdate {
  status?: AcceptanceStatus;
  lastCheckedAt?: Date;
  blockedUntil?: Date;
  validationDetails?: AcceptanceCriterionState['validationDetails'];
  failureAnalysis?: AcceptanceCriterionState['failureAnalysis'];
}
