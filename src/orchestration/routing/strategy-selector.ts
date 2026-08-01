/**
 * Strategy Selector for FlowDeck routing intelligence.
 * @module orchestration/routing/strategy-selector
 */

import type { State } from "../runtime/states.js";
import type { TaskClassification } from "./task-classifier.js";

/**
 * Execution strategies for task routing.
 */
export type ExecutionStrategy =
  | "fast_direct"
  | "direct_verified"
  | "explore_then_execute"
  | "planned_execution"
  | "parallel_implementation"
  | "root_cause_repair"
  | "audit_only"
  | "repair_and_independent_audit"
  | "recovery_resume";

/**
 * Run stages that strategies can transition between.
 */
export type RunStage = State;

/**
 * Strategy definition with all required properties.
 */
export interface StrategyDefinition {
  readonly strategy: ExecutionStrategy;
  readonly allowedTransitions: readonly RunStage[];
  readonly specialistLimit: number;
  readonly requiredReview: boolean;
  readonly requiredVerification: boolean;
  readonly contextBudget: number;
  readonly modelTier: "small" | "general" | "strong";
  readonly recoveryLimit: number;
  readonly humanGates: boolean;
}

/**
 * Selector that maps task classifications to execution strategies.
 */
export class StrategySelector {
  private static readonly STRATEGIES: ReadonlyMap<ExecutionStrategy, StrategyDefinition> =
    new Map<ExecutionStrategy, StrategyDefinition>([
      [
        "fast_direct",
        {
          strategy: "fast_direct",
          allowedTransitions: ["created", "planning", "executing", "completed"],
          specialistLimit: 1,
          requiredReview: false,
          requiredVerification: false,
          contextBudget: 8192,
          modelTier: "small",
          recoveryLimit: 0,
          humanGates: false,
        },
      ],
      [
        "direct_verified",
        {
          strategy: "direct_verified",
          allowedTransitions: ["created", "planning", "executing", "verifying", "completed"],
          specialistLimit: 1,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 16384,
          modelTier: "general",
          recoveryLimit: 1,
          humanGates: false,
        },
      ],
      [
        "explore_then_execute",
        {
          strategy: "explore_then_execute",
          allowedTransitions: ["created", "planning", "analysing", "executing", "verifying", "completed"],
          specialistLimit: 2,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 32768,
          modelTier: "general",
          recoveryLimit: 2,
          humanGates: false,
        },
      ],
      [
        "planned_execution",
        {
          strategy: "planned_execution",
          allowedTransitions: ["created", "planning", "analysing", "delegating", "executing", "verifying", "completed"],
          specialistLimit: 3,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 65536,
          modelTier: "strong",
          recoveryLimit: 3,
          humanGates: true,
        },
      ],
      [
        "parallel_implementation",
        {
          strategy: "parallel_implementation",
          allowedTransitions: ["created", "planning", "analysing", "delegating", "executing", "verifying", "completed"],
          specialistLimit: 5,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 98304,
          modelTier: "strong",
          recoveryLimit: 2,
          humanGates: true,
        },
      ],
      [
        "root_cause_repair",
        {
          strategy: "root_cause_repair",
          allowedTransitions: ["created", "planning", "analysing", "executing", "verifying", "recovering", "completed"],
          specialistLimit: 2,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 32768,
          modelTier: "strong",
          recoveryLimit: 5,
          humanGates: false,
        },
      ],
      [
        "audit_only",
        {
          strategy: "audit_only",
          allowedTransitions: ["created", "planning", "executing", "completed"],
          specialistLimit: 1,
          requiredReview: false,
          requiredVerification: false,
          contextBudget: 16384,
          modelTier: "general",
          recoveryLimit: 0,
          humanGates: true,
        },
      ],
      [
        "repair_and_independent_audit",
        {
          strategy: "repair_and_independent_audit",
          allowedTransitions: ["created", "planning", "analysing", "delegating", "executing", "verifying", "completed"],
          specialistLimit: 4,
          requiredReview: true,
          requiredVerification: true,
          contextBudget: 131072,
          modelTier: "strong",
          recoveryLimit: 3,
          humanGates: true,
        },
      ],
      [
        "recovery_resume",
        {
          strategy: "recovery_resume",
          allowedTransitions: ["created", "recovering", "executing", "verifying", "completed"],
          specialistLimit: 2,
          requiredReview: false,
          requiredVerification: true,
          contextBudget: 8192,
          modelTier: "small",
          recoveryLimit: 10,
          humanGates: false,
        },
      ],
    ]);

  /**
   * Select an execution strategy based on task classification.
   */
  select(classification: TaskClassification): ExecutionStrategy {
    // CI failure with recovery needed
    if (classification.ciFailure) {
      return "recovery_resume";
    }

    // Audit requests
    if (classification.auditRequest) {
      if (classification.repositoryRisk === "high" || classification.securitySensitive) {
        return "repair_and_independent_audit";
      }
      return "audit_only";
    }

    // Security sensitive tasks
    if (classification.securitySensitive) {
      if (classification.verificationSurface === "extensive") {
        return "planned_execution";
      }
      return "direct_verified";
    }

    // Migration tasks
    if (classification.migrationInvolved) {
      return "planned_execution";
    }

    // High repository risk
    if (classification.repositoryRisk === "high") {
      if (classification.verificationSurface === "extensive") {
        return "parallel_implementation";
      }
      return "explore_then_execute";
    }

    // Multi-domain tasks with extensive verification
    if (classification.domainCount >= 2 && classification.verificationSurface === "extensive") {
      if (classification.likelyFileCount > 10) {
        return "parallel_implementation";
      }
      return "explore_then_execute";
    }

    // Root cause repair scenarios
    if (
      classification.ambiguity === "high" &&
      classification.verificationSurface !== "minimal"
    ) {
      return "root_cause_repair";
    }

    // Read-only tasks
    if (classification.readOnly) {
      if (classification.verificationSurface === "minimal") {
        return "fast_direct";
      }
      return "audit_only";
    }

    // Single file, low risk, minimal verification
    if (
      classification.likelyFileCount <= 2 &&
      classification.repositoryRisk === "low" &&
      classification.verificationSurface === "minimal" &&
      classification.ambiguity === "low"
    ) {
      return "fast_direct";
    }

    // Low risk but needs verification
    if (
      classification.repositoryRisk === "low" &&
      classification.verificationSurface !== "minimal"
    ) {
      return "direct_verified";
    }

    // Medium risk tasks
    if (classification.repositoryRisk === "medium") {
      if (classification.ambiguity === "medium") {
        return "explore_then_execute";
      }
      return "direct_verified";
    }

    // High ambiguity or multi-domain tasks
    if (classification.ambiguity === "high" || classification.domainCount >= 3) {
      return "planned_execution";
    }

    // Default to explore_then_execute for moderate complexity
    if (classification.verificationSurface === "moderate") {
      return "explore_then_execute";
    }

    // Catch-all for moderate tasks
    return "direct_verified";
  }

  /**
   * Get the full definition for a strategy.
   */
  getDefinition(strategy: ExecutionStrategy): StrategyDefinition {
    const definition = StrategySelector.STRATEGIES.get(strategy);
    if (!definition) {
      throw new Error(`Unknown execution strategy: ${strategy}`);
    }
    return definition;
  }

  /**
   * Get all available strategies.
   */
  getAllStrategies(): readonly ExecutionStrategy[] {
    return Array.from(StrategySelector.STRATEGIES.keys());
  }
}
