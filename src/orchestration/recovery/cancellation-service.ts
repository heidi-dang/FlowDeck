/**
 * Cancellation service for FlowDeck runtime.
 *
 * Responsibilities:
 * - Create and manage cancellation tokens (tree structure)
 * - Propagate cancellation to child sessions
 * - Cancel in-flight tools and model calls
 * - Release ownership on cancellation
 * - Persist checkpoints for recovery
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
  SerializedState,
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

export class CancellationService {
  private tokens = new Map<string, CancellationToken>();
  private toolOwnership = new Map<string, ToolOwnership>();
  private modelCallOwnership = new Map<string, ModelCallOwnership>();
  private eventHandlers: CancellationEventHandler[] = [];
  private checkpointRepo?: CheckpointRepositoryPort;
  private ownershipPort?: OwnershipPort;

  constructor(
    private readonly config: CancellationServiceConfig = DEFAULT_CONFIG,
  ) {}

  setCheckpointRepository(repo: CheckpointRepositoryPort): void {
    this.checkpointRepo = repo;
  }

  setOwnershipPort(port: OwnershipPort): void {
    this.ownershipPort = port;
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
        handler(event);
      } catch {
        // handlers must not throw
      }
    }
  }

  // ── Token management ──────────────────────────────────────────────────────

  createRootToken(runId: string): CancellationToken {
    const token: CancellationToken = {
      id: `token:root:${runId}`,
      isCancelled: false,
      isRoot: true,
      children: new Set(),
    };
    this.tokens.set(token.id, token);
    return token;
  }

  createChildToken(parentId: string, childId: string): CancellationToken {
    const parent = this.tokens.get(parentId);
    if (!parent) {
      throw new Error(`CANCELLATION_TOKEN_NOT_FOUND: Parent token ${parentId} does not exist`);
    }

    const token: CancellationToken = {
      id: `token:child:${childId}`,
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

  // ── Cancellation operations ──────────────────────────────────────────────

  async cancel(tokenId: string, options: CancellationOptions = {}): Promise<boolean> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error(`CANCELLATION_TOKEN_NOT_FOUND: Token ${tokenId} does not exist`);
    }

    if (token.isCancelled) {
      return false;
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

    // Handle timeout if specified
    if (options.timeout && !options.force) {
      setTimeout(() => {
        const current = this.tokens.get(tokenId);
        if (current?.isCancelled && !this.isForcedCancellation(tokenId)) {
          this.forceCancel(tokenId, "TIMEOUT_EXPIRED");
        }
      }, options.timeout);
    }

    return true;
  }

  private isForcedCancellation(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    return token?.reason === "FORCED" || false;
  }

  private forceCancel(tokenId: string, reason: string): void {
    const token = this.tokens.get(tokenId);
    if (!token || token.isCancelled) return;

    const forcedToken: CancellationToken = {
      ...token,
      isCancelled: true,
      cancelledAt: new Date(),
      reason: `FORCED:${reason}`,
    };
    this.tokens.set(tokenId, forcedToken);
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

  // ── Ownership tracking ────────────────────────────────────────────────────

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

  // ── Checkpoint persistence ────────────────────────────────────────────────

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

  // ── Recovery state ───────────────────────────────────────────────────────

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
    // Count how many times we've recovered this run
    // This is a simplified implementation; in production this would
    // be persisted and tracked properly
    return 0;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  serializeToken(tokenId: string): SerializedCancellationToken | null {
    const token = this.tokens.get(tokenId);
    if (!token) return null;
    return serializeToken(token);
  }

  deserializeAndRestore(data: SerializedCancellationToken): void {
    const token = deserializeToken(data);
    this.tokens.set(token.id, token);
  }
}
