/**
 * Cancellation token system for FlowDeck runtime.
 *
 * Tokens form a tree: cancelling a parent propagates to all children.
 * A token is either root (created for a top-level run) or child (created
 * for a sub-session, tool call, or model invocation).
 */

export interface CancellationToken {
  readonly id: string;
  readonly isCancelled: boolean;
  readonly isRoot: boolean;
  readonly parentId?: string;
  readonly children: ReadonlySet<string>;
  readonly cancelledAt?: Date;
  readonly reason?: string;
}

export interface CancellationOptions {
  /** If true, skip graceful shutdown and cancel immediately. */
  force?: boolean;
  /** Human-readable reason for the cancellation. */
  reason?: string;
  /** Timeout in ms after which the cancellation becomes forced. */
  timeout?: number;
}

export interface CancellationTokenFactory {
  createRootToken(runId: string): CancellationToken;
  createChildToken(parentId: string, childId: string): CancellationToken;
}

export interface SerializedCancellationToken {
  id: string;
  isCancelled: boolean;
  isRoot: boolean;
  parentId?: string;
  children: string[];
  cancelledAt?: string;
  reason?: string;
}

/**
 * Serialize a token for persistence (checkpoint).
 */
export function serializeToken(token: CancellationToken): SerializedCancellationToken {
  return {
    id: token.id,
    isCancelled: token.isCancelled,
    isRoot: token.isRoot,
    parentId: token.parentId,
    children: Array.from(token.children),
    cancelledAt: token.cancelledAt?.toISOString(),
    reason: token.reason,
  };
}

/**
 * Deserialize a token from persistence.
 */
export function deserializeToken(data: SerializedCancellationToken): CancellationToken {
  return {
    id: data.id,
    isCancelled: data.isCancelled,
    isRoot: data.isRoot,
    parentId: data.parentId,
    children: new Set(data.children),
    cancelledAt: data.cancelledAt ? new Date(data.cancelledAt) : undefined,
    reason: data.reason,
  };
}
