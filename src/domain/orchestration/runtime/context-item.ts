/**
 * Context Item entity - runtime-specific context that persists across runs
 * 
 * Invariants:
 * - Must belong to valid run
 * - Cannot span multiple runs
 * - Sources must be stable identifiers (not mutable paths)
 * - Context can be shared across runs but not mutated between runs
 */

import type { TaskRun } from './task-run';

/**
 * Context item type
 */
export type ContextItemType = 
  | 'codebase-summary'
  | 'analysis-result'
  | 'planning-output'
  | 'execution-log'
  | 'verification-report'
  | 'user-input'
  | 'external-reference'
  | 'tool-output'
  | 'aggregated-knowledge';

/**
 * Context item status
 */
export type ContextItemStatus = 
  | 'pending'
  | 'active'
  | 'archived'
  | 'superseded'
  | 'deleted';

/**
 * Context item entity
 */
export interface ContextItem {
  readonly id: string;
  readonly runId: string; // Foreign key - must exist
  readonly type: ContextItemType;
  readonly title: string;
  readonly content: unknown; // Structured or raw content
  readonly source: string; // Stable identifier (e.g., "file:a1b2c3", "ref:d4e5f6")
  readonly status: ContextItemStatus;
  readonly parentId?: string; // For hierarchical context
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt?: Date;
  readonly supersededAt?: Date;
  readonly deletedAt?: Date;
  
  // Metadata
  readonly sizeBytes?: number;
  readonly version?: number;
  readonly checksum?: string;
  
  // Cross-run references
  readonly referencedByRunIds?: string[]; // Runs that reference this context
  
  // Tags for categorization
  readonly tags?: string[];
}

/**
 * Context creation options
 */
export interface CreateContextItemOptions {
  runId: string;
  type: ContextItemType;
  title: string;
  content: unknown;
  source: string;
  status?: ContextItemStatus;
  parentId?: string;
  tags?: string[];
}

/**
 * Context update operations
 */
export interface ContextUpdate {
  content?: unknown;
  status?: ContextItemStatus;
  parentId?: string | null;
  archivedAt?: Date;
  supersededAt?: Date;
  deletedAt?: Date;
  version?: number;
  checksum?: string;
  tags?: string[];
}

/**
 * Source validation - ensures stable identifiers rather than mutable paths
 */
export class ContextSourceValidator {
  /**
   * Validate source is a stable identifier format
   */
  static validateStableSource(source: string): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    // Allowed patterns for stable sources
    const validPatterns = [
      /^ref:[a-zA-Z0-9_-]+$/,       // Reference ID
      /^file:[a-f0-9]+$/,           // File hash
      /^dir:[a-f0-9]+$/,            // Directory hash
      /^symbol:[a-zA-Z0-9_.<>]+$/,  // Symbol reference
      /^url:.+$/, // URL (simplified - accepts any non-empty URL)
      /^agent:[a-zA-Z]+$/,          // Agent-generated context
      /^tool:[a-zA-Z0-9_-]+$/,      // Tool output
      /^session:[a-zA-Z0-9_-]+$/         // Session context (allows alphanumeric)
    ];

    const isValid = validPatterns.some(pattern => pattern.test(source));
    
    if (!isValid) {
      errors.push(
        `Source "${source}" is not a stable identifier. ` +
        `Use patterns like ref:xxx, file:hash, dir:hash, symbol:name, url:..., agent:..., tool:..., or session:...`
      );
    }

    // Reject mutable filesystem paths
    if (/^[a-zA-Z]:\\/.test(source) || source.startsWith('/')) {
      errors.push(
        `Source "${source}" appears to be a mutable filesystem path. ` +
        `Use stable identifiers (file hashes, refs) instead of paths.`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }
}

/**
 * Context consistency validator
 * Ensures context cannot violate run boundaries
 */
export class ContextConsistencyValidator {
  /**
   * Validate context belongs to existing run
   */
  static validateRunOwnership(
    context: Pick<ContextItem, 'id' | 'runId' | 'status'>,
    run: TaskRun | undefined
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (!run) {
      errors.push(`Context ${context.id} references non-existent run ${context.runId}`);
      return { valid: false, errors };
    }

    if (run.status === 'completed' && !['archived', 'deleted'].includes(context.status)) {
      errors.push(
        `Cannot add new context to completed run ${context.runId}. ` +
        `Archive or mark as deleted instead.`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Validate context source stability
   */
  static validateSourceStability(context: Pick<ContextItem, 'source'>): 
    { valid: true } | { valid: false; errors: string[] } {
    return ContextSourceValidator.validateStableSource(context.source);
  }

  /**
   * Ensure no cross-run mutations
   */
  static validateNoCrossRunMutations(
    context: ContextItem,
    referencingRuns: Map<string, TaskRun>,
    isMutation: boolean
  ): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    if (!isMutation) {
      return { valid: true };
    }

    // Check if any referencing run is in terminal state
    const terminalRefs = Array.from(referencingRuns.entries()).filter(([runId, run]) => 
      context.referencedByRunIds?.includes(runId) &&
      ['completed', 'failed', 'cancelled'].includes(run.status)
    );

    if (terminalRefs.length > 0) {
      const runIds = terminalRefs.map(([id]) => id).slice(0, 3); // Limit to first 3
      errors.push(
        `Cannot mutate context ${context.id}. ` +
        `${terminalRefs.length} referencing run(s) are in terminal states: ${runIds.join(', ')}`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * List unique sources for a run (aggregate-level operation)
   */
  static async listUniqueSources(items: Pick<ContextItem, 'source'>[]): Promise<string[]> {
    return [...new Set(items.map(item => item.source))];
  }
}

