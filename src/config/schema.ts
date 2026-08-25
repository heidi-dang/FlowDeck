/**
 * FlowDeck configuration schema.
 *
 * Single source of truth for all configuration keys and types.
 * Every key documented here must have a runtime consumer.
 */

import type { TokenBudgetOverrides } from './token-budget-config';
export type { TokenBudgetOverrides } from './token-budget-config';

export type GovernanceMode = "off" | "advisory" | "strict";

export interface AgentModelConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

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
  heidi?: {
    memory?: { enabled?: boolean; hotBudget?: number; writePolicy?: "off" | "auto" | "review" };
    sessionArchive?: { enabled?: boolean; retention?: number; search?: boolean };
    learning?: { enabled?: boolean; reviewPolicy?: "off" | "auto" | "review"; minimumConfidence?: number };
    skills?: { learnedEnabled?: boolean; progressiveLoading?: boolean };
    toolPipeline?: { enabled?: boolean; maxCalls?: number; timeoutMs?: number; maxOutputBytes?: number };
    scheduler?: { enabled?: boolean; pollIntervalMs?: number; defaultBudget?: number };
  };
  /** Deterministic v2 routing intelligence. Shadow is advisory and non-invasive. */
  routing?: { enabled?: boolean; mode?: "off" | "shadow" | "enforce" };
  /** Per-agent model overrides. When unset, agent inherits UI-selected model. */
  agentModels?: Record<string, AgentModelConfig>;
  /** Legacy per-agent model overrides (deprecated, use agentModels). */
  agents?: Record<string, AgentModelConfig>;
  /** Maximum delegation depth. Default: 1. Must be exactly 1. */
  maxDelegationDepth?: number;
  /** Maximum unique files an agent can write per session. Default: 100. 0 = unlimited. */
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
  /** Better Harness integration configuration. */
  betterHarness?: BetterHarnessConfig;
  /** Runtime agent identity enforcement. */
  runtimeAgent?: {
    /** Enforcement mode: strict (block), warn (log+allow), off (no enforcement). */
    enforcement?: "strict" | "warn" | "off";
    /** Expected runtime agent. Defaults to effective default_agent or "heidi". */
    expectedAgent?: string;
  };
  /** Hierarchical token-budget control. See token-budget-config.ts for profiles and validation. */
  tokenBudget?: TokenBudgetOverrides;
  /**
   * FDX Verifiable Change Intelligence (VCI) M1–M12 integration.
   *
   * Controls how Heidi uses FDX as its code-change intelligence and
   * verification authority. FDX remains authoritative for change analysis,
   * verification planning, and attestation. Heidi remains the orchestrator.
   */
  fdxVci?: {
    /** Enable FDX VCI integration. Default: true. */
    enabled?: boolean;
    /** Override FDX binary path. Uses auto-discovery when unset. */
    binaryPath?: string;
    /** Enable M11 policy overlay (ADD_CHECK only). Default: true when supported. */
    policyOverlayEnabled?: boolean;
    /** Enable M10 shadow calibration recording. Default: true when supported. */
    calibrationEnabled?: boolean;
    /** Maximum verification retry attempts before convergence failure. Default: 3. */
    maxVerificationRetries?: number;
    /** Wall-clock budget per verification cycle in ms. Default: 300000 (5 min). */
    verificationBudgetMs?: number;
    /** Minimum assurance level required for completion. Default: "degraded". */
    minimumAssuranceLevel?: "exact" | "high" | "medium" | "low" | "degraded";
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