/**
 * Cancellation service for FlowDeck runtime.
 *
 * Responsibilities:
 * - Create and manage cancellation tokens (tree structure)
 * - Propagate cancellation to child sessions
 * - Cancel in-flight tools and model calls
 * - Release ownership on cancellation
 * - Persist checkpoints for recovery
 * - Track cancellation phases for force escalation and restart recovery
 */

import { z } from "zod/v4";
import type {
  CancellationToken,
  CancellationOptions,
  SerializedCancellationToken,
} from "./cancellation-token";
import {
  serializeToken,
  deserializeToken,
} from "./cancellation-token";
import type {
  RecoveryState,
  Checkpoint,
  SerializedCheckpoint,
} from "./recovery-state";
import { MAX_RECOVERY_ATTEMPTS } from "./recovery-state";

export const CancellationTokenSchema = z.object({
  id: z.string(),
  isCancelled: z.boolean(),
  isRoot: z.boolean(),
  parentId: z.string().optional(),
  children: z.array(z.string()),
  cancelledAt: z.string().datetime().optional(),
  reason: z.string().optional(),
});

export const CheckpointSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stateSnapshot: z.object({
    phase: z.string(),
    progress: z.number(),
    assignments: z.array(z.string()),
    verifications: z.array(z.string()),
    completedTools: z.array(z.string()),
    pendingTools: z.array(z.string()),
    modelCallState: z.object({
      modelId: z.string(),
      prompt: z.string(),
      responseStarted: z.boolean(),
      partialResponse: z.string().optional(),
    }).optional(),
    metadata: z.record(z.string(), z.unknown()),
  }),
  createdAt: z.string().datetime(),
  hash: z.string(),
});

// Tool ownership tracking
interface ToolOwnership {
  readonly toolId: string;
  readonly tokenId: string;
  readonly acquiredAt: Date;
}

// Model call tracking
interface ModelCallOwnership {
  readonly modelId: string;
  readonly tokenId: string;
  readonly startedAt: Date;
}

export interface CancellationEvent {
  readonly type: "token.cancelled" | "tool.cancelled" | "model.cancelled";
  readonly tokenId: string;
  readonly reason?: string;
  readonly timestamp: Date;
  readonly children?: string[];
}

export type CancellationEventHandler = (event: CancellationEvent) => void | Promise<void>;

export interface CheckpointRepositoryPort {
  saveCheckpoint(checkpoint: SerializedCheckpoint): Promise<void>;
  getLatestCheckpoint(runId: string): Promise<SerializedCheckpoint | null>;
  deleteCheckpointsForRun(runId: string): Promise<void>;
}

export interface OwnershipPort {
  releaseTool(toolId: string): Promise<void>;
  releaseModelCall(modelId: string): Promise<void>;
  getOwnedTools(tokenId: string): Promise<string[]>;
  getOwnedModelCalls(tokenId: string): Promise<string[]>;
}

export interface CancellationServiceConfig {
  readonly defaultTimeoutMs: number;
}

const DEFAULT_CONFIG: CancellationServiceConfig = {
  defaultTimeoutMs: 30_000,
};

/**
 * Cancellation phases tracked per run for restart recovery and force escalation.
 * active → graceful_requested → force_requested → completed
 */
export type CancellationPhase =
  | "active"
  | "graceful_requested"
  | "force_requested"
  | "completed";

/**
 * Repository port for persisting cancellation phases (restart recovery).
 */
export interface CancellationPhaseRepositoryPort {
  savePhase(runId: string, phase: CancellationPhase, details?: Record<string, unknown>): Promise<void>;
  loadPhase(runId: string): Promise<CancellationPhaseState | null>;
  deletePhase(runId: string): Promise<void>;
}

export interface CancellationPhaseState {
  readonly runId: string;
  readonly phase: CancellationPhase;
  readonly details?: Record<string, unknown>;
  readonly updatedAt: Date;
}

export class CancellationService {
  private tokens = new Map<string, CancellationToken>();
  private toolOwnership = new Map<string, ToolOwnership>();
  private modelCallOwnership = new Map<string, ModelCallOwnership>();
  private eventHandlers: CancellationEventHandler[] = [];
  private checkpointRepo?: CheckpointRepositoryPort;
  private ownershipPort?: OwnershipPort;
  private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryAttempts = new Map<string, number>();
  private cancellationPhases = new Map<string, CancellationPhase>();
  private phaseRepo?: CancellationPhaseRepositoryPort;

  constructor(
    private readonly config: CancellationServiceConfig = DEFAULT_CONFIG,
  ) {}

  setCheckpointRepository(repo: CheckpointRepositoryPort): void {
    this.checkpointRepo = repo;
  }

  setOwnershipPort(port: OwnershipPort): void {
    this.ownershipPort = port;
  }

  /**
   * Set the repository for persisting cancellation phases (restart recovery).
   */
  setPhaseRepository(repo: CancellationPhaseRepositoryPort): void {
    this.phaseRepo = repo;
  }

  /**
   * Get the current cancellation phase for a run.
   * Falls back to in-memory state if no repository is configured.
   */
  async getCancelPhase(runId: string): Promise<CancellationPhase> {
    if (this.phaseRepo) {
      const state = await this.phaseRepo.loadPhase(runId);
      if (state) return state.phase;
    }
    return this.cancellationPhases.get(runId) ?? "active";
  }

  /**
   * Persist and update the cancellation phase for a run.
   * Used internally during cancel/force escalation and by external callers
   * that need to track cancellation lifecycle across restarts.
   */
  async setCancelPhase(
    runId: string,
    phase: CancellationPhase,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this.cancellationPhases.set(runId, phase);
    if (this.phaseRepo) {
      await this.phaseRepo.savePhase(runId, phase, details);
    }
  }

  onEvent(handler: CancellationEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  private emit(event: CancellationEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch(() => {
            // Unhandled async rejections must not become unhandled
          });
        }
      } catch {
        // handlers must not throw
      }
    }
  }

  // ── Token management ──────────────────────────────────────────────

  createRootToken(runId: string): CancellationToken {
    const token: CancellationToken = {
      id: `token:root:${runId}`,
      isCancelled: false,
      isRoot: true,
      children: new Set(),
    };
    this.tokens.set(token.id, token);
    // Initialize phase as "active" for restart tracking
    this.cancellationPhases.set(runId, "active");
    return token;
  }

  createChildToken(parentId: string, childId: string): CancellationToken {
    const parent = this.tokens.get(parentId);
    if (!parent) {
      throw new Error(`CANCELLATION_TOKEN_NOT_FOUND: Parent token ${parentId} does not exist`);
    }

    const childTokenId = `token:child:${childId}`;

    // Child ownership cannot be silently overwritten
    if (this.tokens.has(childTokenId)) {
      const existing = this.tokens.get(childTokenId);
      if (existing && existing.parentId === parentId) {
        // Already exists with same parent - return existing
        return existing;
      }
      throw new Error(`CANCELLATION_TOKEN_EXISTS: Child token ${childTokenId} already exists with different parent`);
    }

    const token: CancellationToken = {
      id: childTokenId,
      isCancelled: false,
      isRoot: false,
      parentId: parentId,
      children: new Set(),
    };

    // Link child to parent
    const updatedParent: CancellationToken = {
      ...parent,
      children: new Set([...parent.children, token.id]),
    };
    this.tokens.set(parentId, updatedParent);
    this.tokens.set(token.id, token);

    return token;
  }

  getToken(tokenId: string): CancellationToken | undefined {
    return this.tokens.get(tokenId);
  }

  // ── Cancellation operations ──────────────────────────────────────

  async cancel(tokenId: string, options: CancellationOptions = {}): Promise<boolean> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error(`CANCELLATION_TOKEN_NOT_FOUND: Token ${tokenId} does not exist`);
    }

    // Idempotent cleanup - if already cancelled, succeed unless force is set
    if (token.isCancelled && !options.force) {
      return false;
    }

    // Extract runId from root token for phase tracking
    const isRoot = tokenId.startsWith("token:root:");
    const runId = isRoot ? tokenId.replace(/^token:root:/, "") : "";

    // Phase transition: active → graceful_requested (or force_requested if forced)
    if (isRoot) {
      const currentPhase = await this.getCancelPhase(runId);
      if (options.force) {
        await this.setCancelPhase(runId, "force_requested", {
          reason: options.reason,
          forced: true,
          tokenId,
        });
      } else if (currentPhase === "active") {
        await this.setCancelPhase(runId, "graceful_requested", {
          reason: options.reason,
          forced: false,
          tokenId,
        });
      }
    }

    const cancelledAt = new Date();
    const cancelledToken: CancellationToken = {
      ...token,
      isCancelled: true,
      cancelledAt,
      reason: options.reason,
    };
    this.tokens.set(tokenId, cancelledToken);

    // Emit cancellation event
    this.emit({
      type: "token.cancelled",
      tokenId,
      reason: options.reason,
      timestamp: cancelledAt,
      children: Array.from(token.children),
    });

    // Release owned resources for this token
    await this.releaseOwnershipForToken(tokenId);

    // Parent-to-Child Propagation: cancel all registered children
    await this.cancelChildren(tokenId);

    // Handle timeout if specified (use default if none provided)
    const timeout = options.timeout ?? this.config.defaultTimeoutMs;
    if (timeout > 0 && !options.force && isRoot) {
      const timeoutId = setTimeout(() => {
        const current = this.tokens.get(tokenId);
        if (current?.isCancelled && !this.isForcedCancellation(tokenId)) {
          void this.escalateForce(runId, "TIMEOUT_EXPIRED");
        }
      }, timeout);
      // Store timeout ID for cleanup
      this.pendingTimeouts.set(tokenId, timeoutId);
    }

    // If forced, mark phase as completed and clear any pending escalation timeout
    if (options.force && isRoot) {
      const timeoutId = this.pendingTimeouts.get(tokenId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.pendingTimeouts.delete(tokenId);
      }
      await this.setCancelPhase(runId, "completed", {
        reason: options.reason,
        forced: true,
      });
    }

    return true;
  }

  /**
   * Force escalation: transitions graceful_requested → force_requested → completed.
   * Called after timeout or explicit force escalation.
   */
  private async escalateForce(runId: string, reason: string): Promise<void> {
    const currentPhase = await this.getCancelPhase(runId);

    // Record the escalation phase (graceful_requested → force_requested)
    if (currentPhase === "active" || currentPhase === "graceful_requested") {
      await this.setCancelPhase(runId, "force_requested", {
        reason,
        escalated: true,
      });
    }

    // Force-cancel the root token
    const tokenId = `token:root:${runId}`;
    const token = this.tokens.get(tokenId);
    if (token && !token.isCancelled) {
      const forcedToken: CancellationToken = {
        ...token,
        isCancelled: true,
        cancelledAt: new Date(),
        reason: `FORCED:${reason}`,
      };
      this.tokens.set(tokenId, forcedToken);
    } else if (token && !this.isForcedCancellation(tokenId)) {
      const forcedToken: CancellationToken = {
        ...token,
        reason: `FORCED:${reason}`,
      };
      this.tokens.set(tokenId, forcedToken);
    }

    // Cancel all children recursively
    await this.cancelChildren(tokenId);

    // Release owned tools and model calls
    await this.releaseOwnershipForToken(tokenId);

    // Release pending timeout for the token
    const timeoutId = this.pendingTimeouts.get(tokenId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.pendingTimeouts.delete(tokenId);
    }

    // Persist final phase as completed
    await this.setCancelPhase(runId, "completed", {
      reason,
      escalated: true,
    });

    this.emit({
      type: "token.cancelled",
      tokenId,
      reason: `FORCED:${reason}`,
      timestamp: new Date(),
      children: token ? Array.from(token.children) : [],
    });
  }

  private isForcedCancellation(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    return token?.reason?.startsWith("FORCED") || false;
  }

  private async forceCancel(tokenId: string, reason: string): Promise<void> {
    const token = this.tokens.get(tokenId);
    if (!token || token.isCancelled) return;

    const forcedToken: CancellationToken = {
      ...token,
      isCancelled: true,
      cancelledAt: new Date(),
      reason: `FORCED:${reason}`,
    };
    this.tokens.set(tokenId, forcedToken);

    // Cancel all children recursively
    await this.cancelChildren(tokenId);

    // Release owned tools and model calls
    await this.releaseOwnershipForToken(tokenId);

    // Release pending timeout for the token
    const timeoutId = this.pendingTimeouts.get(tokenId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.pendingTimeouts.delete(tokenId);
    }

    // Update cancellation phase if this is a root token
    if (tokenId.startsWith("token:root:")) {
      const runId = tokenId.replace(/^token:root:/, "");
      void this.setCancelPhase(runId, "completed", {
        reason: `FORCED:${reason}`,
      });
    }
  }

  async cancelChildren(tokenId: string): Promise<string[]> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error(`CANCELLATION_TOKEN_NOT_FOUND: Token ${tokenId} does not exist`);
    }

    const cancelledChildren: string[] = [];

    for (const childId of token.children) {
      await this.cancel(childId, { reason: `Parent cancelled: ${tokenId}` });
      cancelledChildren.push(childId);

      // Recursively cancel grandchildren
      const grandchildren = await this.cancelChildren(childId);
      cancelledChildren.push(...grandchildren);
    }

    return cancelledChildren;
  }

  async cancelTool(toolId: string): Promise<boolean> {
    const ownership = this.toolOwnership.get(toolId);
    if (!ownership) {
      return false;
    }

    await this.ownershipPort?.releaseTool(toolId);
    this.toolOwnership.delete(toolId);

    this.emit({
      type: "tool.cancelled",
      tokenId: ownership.tokenId,
      reason: `Tool cancelled: ${toolId}`,
      timestamp: new Date(),
    });

    return true;
  }

  async cancelModel(modelId: string): Promise<boolean> {
    const ownership = this.modelCallOwnership.get(modelId);
    if (!ownership) {
      return false;
    }

    await this.ownershipPort?.releaseModelCall(modelId);
    this.modelCallOwnership.delete(modelId);

    this.emit({
      type: "model.cancelled",
      tokenId: ownership.tokenId,
      reason: `Model call cancelled: ${modelId}`,
      timestamp: new Date(),
    });

    return true;
  }

  // ── Ownership tracking ────────────────────────────────────────────

  acquireToolOwnership(toolId: string, tokenId: string): void {
    const token = this.tokens.get(tokenId);
    if (!token || token.isCancelled) {
      throw new Error(`CANCELLATION_TOKEN_INVALID: Cannot acquire ownership with cancelled token ${tokenId}`);
    }

    this.toolOwnership.set(toolId, {
      toolId,
      tokenId,
      acquiredAt: new Date(),
    });
  }

  acquireModelCallOwnership(modelId: string, tokenId: string): void {
    const token = this.tokens.get(tokenId);
    if (!token || token.isCancelled) {
      throw new Error(`CANCELLATION_TOKEN_INVALID: Cannot acquire ownership with cancelled token ${tokenId}`);
    }

    this.modelCallOwnership.set(modelId, {
      modelId,
      tokenId,
      startedAt: new Date(),
    });
  }

  private async releaseOwnershipForToken(tokenId: string): Promise<void> {
    // Release tools
    for (const [toolId, ownership] of this.toolOwnership) {
      if (ownership.tokenId === tokenId) {
        await this.ownershipPort?.releaseTool(toolId);
        this.toolOwnership.delete(toolId);
      }
    }

    // Release model calls
    for (const [modelId, ownership] of this.modelCallOwnership) {
      if (ownership.tokenId === tokenId) {
        await this.ownershipPort?.releaseModelCall(modelId);
        this.modelCallOwnership.delete(modelId);
      }
    }
  }

  // ── Checkpoint persistence ────────────────────────────────────────

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    if (!this.checkpointRepo) {
      throw new Error("CHECKPOINT_REPOSITORY_NOT_CONFIGURED");
    }

    const serialized: SerializedCheckpoint = {
      id: checkpoint.id,
      runId: checkpoint.runId,
      stateSnapshot: checkpoint.stateSnapshot,
      createdAt: checkpoint.createdAt.toISOString(),
      hash: checkpoint.hash,
    };

    await this.checkpointRepo.saveCheckpoint(serialized);
  }

  async getLatestCheckpoint(runId: string): Promise<Checkpoint | null> {
    if (!this.checkpointRepo) {
      throw new Error("CHECKPOINT_REPOSITORY_NOT_CONFIGURED");
    }

    const serialized = await this.checkpointRepo.getLatestCheckpoint(runId);
    if (!serialized) return null;

    return {
      id: serialized.id,
      runId: serialized.runId,
      stateSnapshot: serialized.stateSnapshot,
      createdAt: new Date(serialized.createdAt),
      hash: serialized.hash,
    };
  }

  // ── Recovery state ────────────────────────────────────────────────

  async buildRecoveryState(
    runId: string,
    checkpointId: string,
    changedHypothesis: boolean,
    retryFingerprint?: string,
    circuitBreakerOpen: boolean = false,
  ): Promise<RecoveryState> {
    const latestCheckpoint = await this.getLatestCheckpoint(runId);
    const recoveryAttempts = this.countRecoveryAttempts(runId);

    return {
      runId,
      checkpointId,
      recoveryAttempts,
      lastCheckpointAt: latestCheckpoint?.createdAt ?? new Date(),
      changedHypothesis,
      retryFingerprint,
      circuitBreakerOpen,
    };
  }

  private countRecoveryAttempts(runId: string): number {
    // Recovery attempts must use persisted or authoritative state
    // Count must not reset on process restart - use persisted checkpoint count
    const attempts = this.recoveryAttempts.get(runId) ?? 0;
    // Bounded recovery retries - no infinite retry loops
    return Math.min(attempts, MAX_RECOVERY_ATTEMPTS);
  }

  recordRecoveryAttempt(runId: string): void {
    const current = this.recoveryAttempts.get(runId) ?? 0;
    this.recoveryAttempts.set(runId, current + 1);
  }

  /**
   * Returns the current in-memory recovery attempt count for a run.
   */
  getRecoveryAttemptCount(runId: string): number {
    return this.recoveryAttempts.get(runId) ?? 0;
  }

  /**
   * Seeds the in-memory recoveryAttempts map from persisted state (used on restart).
   */
  restoreRecoveryAttempts(runId: string, count: number): void {
    this.recoveryAttempts.set(runId, count);
  }

  // ── Serialization ─────────────────────────────────────────────────

  serializeToken(tokenId: string): SerializedCancellationToken | null {
    const token = this.tokens.get(tokenId);
    if (!token) return null;
    return serializeToken(token);
  }

  deserializeAndRestore(data: SerializedCancellationToken): void {
    const token = deserializeToken(data);
    this.tokens.set(token.id, token);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Dispose of all resources held by this service.
   * No timers, handlers, tokens, workers, or subprocesses may remain after disposal.
   */
  dispose(): void {
    // Clear all pending timeouts
    for (const [_, timeoutId] of this.pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    this.pendingTimeouts.clear();

    // Clear event handlers
    this.eventHandlers = [];

    // Clear all tokens
    this.tokens.clear();

    // Clear ownership maps
    this.toolOwnership.clear();
    this.modelCallOwnership.clear();

    // Clear recovery attempts
    this.recoveryAttempts.clear();

    // Clear cancellation phases
    this.cancellationPhases.clear();

    // Clear checkpoint repo reference
    this.checkpointRepo = undefined;
    this.ownershipPort = undefined;
    this.phaseRepo = undefined;
  }
}