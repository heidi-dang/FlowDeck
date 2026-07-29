/**
 * Outbox Delivery Domain - Phase 3C
 * 
 * Implements atomic outbox pattern for reliable event delivery
 */

import type { PersistedRuntimeEvent } from '../event-store/types';

/**
 * Claim boundaries for bounded batch processing
 */

export interface BoundedClaim {
  readonly claimId: string;
  readonly worktreeKey: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly batchSize: number;
  readonly claimedAt: Date;
  readonly expiresAt: Date;
  readonly cursorStart: number; // Sequence number start
  readonly cursorEnd: number;   // Sequence number end (exclusive)
}

/**
 * Deliverable message envelope
 */
export interface DeliverableMessage {
  readonly messageId: string;
  readonly eventType: string;
  readonly payloadVersion: string;
  readonly payloadHash: string;
  readonly aggregateId: string;
  readonly globalSequence: number;
  readonly occurredAt: Date;
  readonly commandId?: string;
  readonly correlationId?: string;
}

/**
 * Outbox record (atomic append target)
 */
export interface OutboxRecord {
  readonly recordId: string;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly events: PersistedRuntimeEvent[];
  readonly deliveredAt?: Date;
  readonly deliveryAttempts: number;
  readonly lastAttemptedAt?: Date;
  readonly nextRetryAt?: Date;
  readonly status: 'pending' | 'delivering' | 'delivered' | 'dead-lettered';
  readonly errorMessage?: string;
}

/**
 * Subscriber matching configuration
 */
export interface SubscriberConfig {
  readonly subscriberId: string;
  readonly topics: string[]; // Event types to subscribe to
  readonly matchPattern: 'exact' | 'prefix' | 'regex';
  readonly priority: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxBackoffMs: number;
}

/**
 * Delivery attempt tracking
 */
export interface DeliveryAttempt {
  readonly attemptId: string;
  readonly messageId: string;
  readonly attemptedAt: Date;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorType?: 'NETWORK' | 'CONNECTION' | 'SERIALIZATION' | 'TIMEOUT' | 'PERMANENT' | 'BUSY';
  readonly errorMessage?: string;
  readonly backoffSeconds: number;
}

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitter: boolean;
  readonly retryableErrors: Set<string>;
  readonly permanentErrors: Set<string>;
}

/**
 * Consumer offset state
 */
export interface ConsumerOffset {
  readonly subscriberId: string;
  readonly topic: string;
  readonly committedSequence: number; // Last successfully processed sequence
  readonly committedAt: Date;
  readonly lag: number; // Current head - committed (if known)
}

/**
 * Dead letter record
 */
export interface DeadLetterRecord {
  readonly recordId: string;
  readonly originalMessageId: string;
  readonly originalAggregateId: string;
  readonly originalSequence: number;
  readonly originalEventType: string;
  readonly originalPayload: unknown;
  readonly failureReason: string;
  readonly failureTimestamp: Date;
  readonly attemptCount: number;
  finalErrorMessage: string;
}

/**
 * Outbox Delivery Adapter for typed test seams
 */
export interface OutboxDeliveryAdapter {
  deliver(message: DeliverableMessage): Promise<void>;
}

/**
 * Outbox port interface
 */
export interface OutboxPort {
  /**
   * Atomic claim of bounded batch of pending messages
   */
  claimBatch(
    worktreeKey: string,
    ownerId: string,
    fencingToken: number,
    batchSize: number
  ): Promise<BoundedClaim | null>;

  /**
   * Atomically append outbox records within a transaction
   */
  appendOutbox(records: OutboxRecord[]): Promise<void>;

  /**
   * Deliver messages outside transaction context
   */
  deliverMessages(claim: BoundedClaim, messages: DeliverableMessage[]): Promise<{
    delivered: DeliverableMessage[];
    failed: DeliverableMessage[];
    attempts: DeliveryAttempt[];
  }>;

  /**
   * Mark messages as delivered (commit offset atomically)
   */
  markDelivered(messageIds: string[], fencingToken: number): Promise<void>;

  /**
   * Retry failed messages with exponential backoff
   */
  retryFailedMessages(policy: RetryPolicy): Promise<number>;

  /**
   * Move exhausted messages to dead letter queue
   */
  moveToDeadLetter(messageIds: string[]): Promise<string[]>;

  /**
   * Get next subscriber offset for a topic
   */
  getOffset(subscriberId: string, topic: string): Promise<ConsumerOffset | null>;

  /**
   * Commit offset after successful delivery
   */
  commitOffset(offset: ConsumerOffset): Promise<void>;

  /**
   * Release expired claims safely
   */
  releaseExpiredClaims(now: Date): Promise<number>;

  /**
   * Reject stale acknowledgements (fencing token check)
   */
  rejectStaleAcknowledgement(acknowledgement: { messageId: string; token: number }): Promise<boolean>;

  /**
   * Restart recovery from last stable offset
   */
  recoverFromOffset(subscriberId: string, topic: string, sequence: number): Promise<DeliverableMessage[]>;

  /**
   * Check duplicate delivery idempotency
   */
  isDuplicateDelivery(messageId: string): Promise<boolean>;
}

/**
 * Default retry policy
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  multiplier: 2,
  jitter: true,
  retryableErrors: new Set(['NETWORK', 'CONNECTION', 'TIMEOUT']),
  permanentErrors: new Set(['SERIALIZATION', 'PERMANENT'])
};

/**
 * Calculate backoff with jitter
 */
export function calculateBackoff(attemptNumber: number, policy: RetryPolicy): number {
  const baseDelay = policy.initialDelayMs * Math.pow(policy.multiplier, attemptNumber - 1);
  const cappedDelay = Math.min(baseDelay, policy.maxDelayMs);
  
  if (policy.jitter) {
    const jitterAmount = cappedDelay * 0.1;
    const randomBuffer = new Uint32Array(1);
    crypto.getRandomValues(randomBuffer);
    const randomRatio = randomBuffer[0] / 0xffffffff;
    return cappedDelay + (randomRatio * jitterAmount * 2 - jitterAmount);
  }
  
  return cappedDelay;
}

/**
 * Classify error type
 */
export function classifyError(error: Error): DeliveryAttempt['errorType'] {
  if (error.message.includes('network') || error.message.includes('ETIMEDOUT')) {
    return 'NETWORK';
  }
  if (error.message.includes('connection')) {
    return 'CONNECTION';
  }
  if (error.message.includes('serialization') || error.message.includes('parse')) {
    return 'SERIALIZATION';
  }
  if (error.message.includes('timeout')) {
    return 'TIMEOUT';
  }
  if (error.name === 'ValidationError' || error.message.includes('permanent')) {
    return 'PERMANENT';
  }
  
  return 'NETWORK'; // Default to retryable
}

/**
 * Check if error is retryable
 */
export function isRetryable(errorType: DeliveryAttempt['errorType'], policy: RetryPolicy): boolean {
  // If no error type specified (success case), consider retryable
  if (!errorType) return false;
  return !policy.permanentErrors.has(errorType);
}

/**
 * Match subscriber to event type
 */
export function matchesTopic(subscriber: SubscriberConfig, eventType: string): boolean {
  switch (subscriber.matchPattern) {
    case 'exact':
      return subscriber.topics.includes(eventType);
    
    case 'prefix':
      return subscriber.topics.some(prefix => eventType.startsWith(prefix));
    
    case 'regex':
      return subscriber.topics.some(pattern => new RegExp(pattern).test(eventType));
    
    default:
      return false;
  }
}
