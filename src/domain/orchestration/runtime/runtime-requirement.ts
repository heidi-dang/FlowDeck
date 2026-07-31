/**
 * Runtime Requirement entity - requirements validated at runtime
 */


/**
 * Requirement type
 */
export type RequirementType = 
  | 'security'
  | 'performance'
  | 'reliability'
  | 'maintainability'
  | 'usability'
  | 'compatibility'
  | 'compliance';

/**
 * Requirement status
 */
export type RequirementStatus = 
  | 'pending'
  | 'in-progress'
  | 'validated'
  | 'failed'
  | 'skipped';

/**
 * Runtime requirement entity
 */
export interface RuntimeRequirement {
  readonly id: string;
  readonly runId: string; // Foreign key - must exist
  readonly title: string;
  readonly description?: string;
  readonly type: RequirementType;
  readonly criteria: string;
  readonly status: RequirementStatus;
  readonly priority: number; // 1-5, where 1 is highest
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly validatedAt?: Date;
  readonly failedAt?: Date;
  readonly skippedAt?: Date;
  
  // Validation results
  readonly validationResults?: {
    passed: boolean;
    details: string[];
    evidence?: string[];
    validator?: string;
  };
}

/**
 * Runtime requirement creation options
 */
export interface CreateRuntimeRequirementOptions {
  runId: string;
  title: string;
  description?: string;
  type: RequirementType;
  criteria: string;
  priority?: number;
}

/**
 * Runtime requirement update operations
 */
export interface RuntimeRequirementUpdate {
  status?: RequirementStatus;
  priority?: number;
  validationResults?: RuntimeRequirement['validationResults'];
  validatedAt?: Date;
  failedAt?: Date;
  skippedAt?: Date;
}
