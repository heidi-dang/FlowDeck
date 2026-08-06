/**
 * FlowDeck configuration schema.
 *
 * Single source of truth for all configuration keys.
 * Every key documented here must have a runtime consumer.
 * Keys without a runtime consumer must be removed.
 */

import type { AgentModelConfig } from './agent-models';
export type { AgentModelConfig } from './agent-models';

export type GovernanceMode = "off" | "advisory" | "strict";

/**
 * @deprecated Better Harness is a standalone development/QA facility.
 *
 * The production plugin no longer activates the Better Harness runtime.
 * `betterHarness.enabled=true` in a production configuration is REJECTED by
 * `loadFlowDeckConfig` with a migration error (fail closed). Any other
 * `betterHarness` fields are deprecated and inert in the production plugin;
 * they only apply to the standalone command:
 *
 *   flowdeck-better-harness --project <path> [--state-dir <dir>]
 *
 * Removal version: next minor after the standalone migration window closes.
 * See docs/architecture/integration/runtime-authority.md for the timeline.
 */
export interface BetterHarnessConfig {
  enabled?: boolean;
  port?: number;
  bindHost?: string;
  eventLogDir?: string;
  authToken?: string;
  authEnabled?: boolean;
  maxBodySize?: number;
  corsOrigins?: string[];
}

export interface FlowDeckConfig {
  /** Per-agent model overrides. When unset, agent inherits UI-selected model. */
  agentModels?: Record<string, AgentModelConfig>;
  /** Legacy per-agent model overrides (deprecated, use agentModels). */
  agents?: Record<string, AgentModelConfig>;
  /** Maximum delegation depth. Default: 1. Must be exactly 1. */
  maxDelegationDepth?: number;
  /** Maximum unique files an agent can write per session. Default: 15. 0 = unlimited. */
  maxWritesPerAgent?: number;
  /** Design-first workflow configuration. */
  designFirst?: {
    enabled?: boolean;
    enforcement?: GovernanceMode;
    requireApprovalBeforeImplementation?: boolean;
    modelOverrides?: Record<string, string>;
    defaultSkillsByTaskType?: Record<string, string[]>;
  };
  /** Governance layer configuration. All subsystems support off/advisory/strict modes. */
  governance?: GovernanceConfig;
  /** Supervisor configuration. */
  supervisor?: SupervisorConfig;
  /** @deprecated Better Harness standalone dev/QA configuration. Rejected when enabled=true; inert otherwise. Use the flowdeck-better-harness command instead. */
  betterHarness?: BetterHarnessConfig;
  /** Runtime agent identity enforcement. */
  runtimeAgent?: {
    /** Enforcement mode: strict (block), warn (log+allow), off (no enforcement). */
    enforcement?: "strict" | "warn" | "off";
    /** Expected runtime agent. Defaults to effective default_agent or "heidi". */
    expectedAgent?: string;
  };
}

export interface GovernanceConfig {
  /** Global governance mode shorthand — sets all subsystems unless overridden. */
  mode?: GovernanceMode;
  /** Agent contract validator mode. */
  validator?: {
    mode?: GovernanceMode;
    /** Tool allowlist enforcement. Default: warn when mode != off */
    contractEnforcement?: "off" | "warn" | "strict";
  };
  /** Tool permission guard mode. */
  toolGuard?: {
    mode?: GovernanceMode;
    /** Dangerous operation blocklist */
    blockDangerousOps?: boolean;
    /** Architecture constraint enforcement */
    enforceArchConstraints?: boolean;
    /** Per-agent write limits */
    enforceWriteLimits?: boolean;
  };
  /** Guard rails for planning pipeline enforcement. */
  guardRails?: {
    mode?: GovernanceMode;
    /** Force fd-task -> fd-review -> fd-execute -> fd-verify -> fd-done order */
    enforcePipeline?: boolean;
  };
  /** Loop detection configuration. */
  loopDetection?: {
    enabled?: boolean;
    /** How many identical-result repeats before blocking. Default: 2 */
    maxRepeats?: number;
    /** Similarity threshold (0-1) for treating outputs as no-progress. Default: 0.9 */
    similarityThreshold?: number;
    /** Maximum actions in memory per session. Default: 20 */
    historySize?: number;
  };
  /** Delegation budget configuration. */
  delegationBudget?: {
    maxToolCalls?: number;
    maxDepth?: number;
    maxDelegations?: number;
    maxSameStepRetries?: number;
  };
  /** Audit log configuration. */
  auditLog?: {
    enabled?: boolean;
    maxFileSize?: number;
    retentionCount?: number;
  };
  /** Verification layer configuration. */
  verification?: {
    enabled?: boolean;
    requireVerificationBeforeComplete?: boolean;
  };
}

export interface SupervisorConfig {
  enabled?: boolean;
  mode?: GovernanceMode;
  reviewedTargets?: string[];
  /** Whether supervisor can block execution. */
  canBlock?: boolean;
  /** Confidence threshold (0-1) for approve decision. Default: 0.7 */
  confidenceThreshold?: number;
}

