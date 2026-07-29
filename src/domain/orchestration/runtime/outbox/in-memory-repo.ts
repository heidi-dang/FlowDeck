/**
 * In-Memory Outbox Implementation - Phase 3C
 */

import { 
  BoundedClaim, 
  DeliverableMessage,
  OutboxRecord,
  SubscriberConfig,
  DeliveryAttempt,
  RetryPolicy,
  ConsumerOffset,
  DeadLetterRecord,
  calculateBackoff,
  DEFAULT_RETRY_POLICY,
  classifyError as classifyOutboxError,
  isRetryable as isOutboxRetryable
} from './port.js';

/**
 * Classification of delivery error type
 */
export function classifyError(error: Error): DeliveryAttempt['errorType'] {
  const m = error.message.toLowerCase();
  if (m.includes('network') || m.includes('etimedout')) return 'NETWORK';
  if (m.includes('connection') || m.includes('econnrefused')) return 'CONNECTION';
  if (m.includes('serialization') || m.includes('parse')) return 'SERIALIZATION';
  if (m.includes('timeout')) return 'TIMEOUT';
  if (error.name === 'ValidationError' || m.includes('permanent')) return 'PERMANENT';
  if (m.includes('busy') || m.includes('overload')) return 'BUSY';
  return undefined; // Default to success or unspecified
}

/**
 * Check if error is retryable based on policy
 */
export function isRetryable(errorType: DeliveryAttempt['errorType'], policy: RetryPolicy): boolean {
  if (!errorType) return false;
  return !policy.permanentErrors.has(errorType);
}

import type { PersistedRuntimeEvent } from '../event-store/types';

// Utility functions (standalone exports)
export function matchesTopic(event: PersistedRuntimeEvent, subscription: SubscriberConfig): boolean {
  if (!subscription?.topics?.length) return true;
  return subscription.topics.includes(event.eventType);
}


interface RecordIndex {
  byId: Map<string, OutboxRecord>;
  byAggregate: Map<string, string[]>; // aggregateId → recordIds
}

interface ClaimIndex {
  active: Map<string, BoundedClaim>; // worktreeKey → claim
  byOwner: Map<string, BoundedClaim>; // ownerId → claim
}

interface OffsetIndex {
  offsets: Map<string, ConsumerOffset>; // ${subscriberId}:${topic} → offset
}

interface DeadLetterIndex {
  records: Map<string, DeadLetterRecord>; // recordId → DLQ record
}

/**
 * In-memory outbox repository with bounded claims and fencing
 */
export class InMemoryOutboxRepository {
  private records: RecordIndex = {
    byId: new Map(),
    byAggregate: new Map()
  };
  
  private claims: ClaimIndex = {
    active: new Map(),
    byOwner: new Map()
  };
  
  private offsets: OffsetIndex = {
    offsets: new Map()
  };
  
  private deadLetters: DeadLetterIndex = {
    records: new Map()
  };
  
  private messages: Map<string, DeliverableMessage> = new Map();
  private deliveries: Map<string, boolean> = new Map(); // messageId → delivered (idempotency)

  async claimBatch(
    worktreeKey: string,
    ownerId: string,
    fencingToken: number,
    batchSize: number
  ): Promise<BoundedClaim | null> {
    // Reject if already owned by different owner
    const existing = this.claims.active.get(worktreeKey);
    if (existing && existing.ownerId !== ownerId) {
      return null;
    }

    // Get pending records for this owner's range
    const pendingRecords: OutboxRecord[] = [];
    
    for (const [recordId, record] of this.records.byId.entries()) {
      if (record.status === 'pending' && !pendingRecords.includes(record)) {
        pendingRecords.push(record);
        
        if (pendingRecords.length >= batchSize) {
          break;
        }
      }
    }

    if (pendingRecords.length === 0) {
      return null;
    }

    const now = new Date();
    const claim: BoundedClaim = {
      claimId: `claim_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      worktreeKey,
      ownerId,
      fencingToken,
      batchSize: pendingRecords.length,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + 30000), // 30s TTL
      cursorStart: 1,
      cursorEnd: pendingRecords.reduce((max, r) => Math.max(max, ...r.events.map(e => e.globalSequence)), 0)
    };

    this.claims.active.set(worktreeKey, claim);
    this.claims.byOwner.set(ownerId, claim);

    return claim;
  }

  async appendOutbox(records: OutboxRecord[]): Promise<void> {
    for (const record of records) {
      this.records.byId.set(record.recordId, record);
      
      const existing = this.records.byAggregate.get(record.aggregateId) ?? [];
      existing.push(record.recordId);
      this.records.byAggregate.set(record.aggregateId, existing);
    }
  }

  async deliverMessages(
    claim: BoundedClaim,
    messages: DeliverableMessage[]
  ): Promise<{ delivered: DeliverableMessage[]; failed: DeliverableMessage[]; attempts: DeliveryAttempt[] }> {
    const delivered: DeliverableMessage[] = [];
    const failed: DeliverableMessage[] = [];
    const attempts: DeliveryAttempt[] = [];

    for (const message of messages) {
      const startTime = Date.now();
      let success = false;
      let errorType: DeliveryAttempt['errorType'] = undefined;
      let errorMessage = '';

      try {
        // Simulate delivery (in production, send to event broker)
        await this.simulateDelivery(message);
        success = true;
      } catch (error: any) {
        errorType = classifyError(error);
        errorMessage = error.message;
        success = false;
      }

      const attempt: DeliveryAttempt = {
        attemptId: `attempt_${message.messageId}_${Date.now()}`,
        messageId: message.messageId,
        attemptedAt: new Date(),
        durationMs: Date.now() - startTime,
        success,
        errorType,
        errorMessage,
        backoffSeconds: success ? 0 : calculateBackoff(1, DEFAULT_RETRY_POLICY) / 1000
      };

      attempts.push(attempt);

      if (success) {
        delivered.push(message);
        this.deliveries.set(message.messageId, true);
      } else {
        failed.push(message);
      }
    }

    return { delivered, failed, attempts };
  }

  async markDelivered(messageIds: string[], fencingToken: number): Promise<void> {
    // Fencing token validation
    const claim = this.claims.byOwner.get('current_owner');
    if (claim && claim.fencingToken !== fencingToken) {
      throw new Error('Stale fencing token');
    }

    for (const messageId of messageIds) {
      // Update outbox records by finding matching events
      for (const record of this.records.byId.values()) {
        for (const event of record.events) {
          if (event.eventId === messageId) {
            // Create immutable copy with updated status
            const updatedRecord: OutboxRecord = {
              ...record,
              status: 'delivered',
              deliveredAt: new Date(),
              deliveryAttempts: record.deliveryAttempts + 1
            };
            this.records.byId.set(record.recordId, updatedRecord);
            break;
          }
        }
      }
    }
  }

  async retryFailedMessages(policy: RetryPolicy): Promise<number> {
    let retriedCount = 0;

    for (const record of this.records.byId.values()) {
      if (record.status === 'pending' && record.deliveryAttempts < policy.maxAttempts) {
        const nextDelay = calculateBackoff(record.deliveryAttempts + 1, policy);
        const updatedRecord: OutboxRecord = {
          ...record,
          nextRetryAt: new Date(Date.now() + nextDelay),
          status: 'delivering'
        };
        this.records.byId.set(record.recordId, updatedRecord);
        retriedCount++;
      }
    }

    return retriedCount;
  }

  async moveToDeadLetter(messageIds: string[]): Promise<string[]> {
    const deletedIds: string[] = [];

    for (const messageId of messageIds) {
      const record = Array.from(this.records.byId.values()).find(r => 
        r.events.some((e: PersistedRuntimeEvent) => e.eventId === messageId)
      );

      if (record) {
        const dlqRecord: DeadLetterRecord = {
          recordId: `${record.recordId}_dlq`,
          originalMessageId: messageId,
          originalAggregateId: record.aggregateId,
          originalSequence: record.events[0]?.globalSequence ?? 0,
          originalEventType: record.events[0]?.eventType ?? 'unknown',
          originalPayload: record.events[0]?.event,
          failureReason: 'Maximum retries exceeded',
          failureTimestamp: new Date(),
          attemptCount: record.deliveryAttempts,
          finalErrorMessage: record.errorMessage || 'Unknown'
        };

        // Create immutable copy with dead-lettered status
        const updatedRecord: OutboxRecord = {
          ...record,
          status: 'dead-lettered',
          errorMessage: dlqRecord.finalErrorMessage
        };
        this.records.byId.set(record.recordId, updatedRecord);
        this.deadLetters.records.set(dlqRecord.recordId, dlqRecord);
        deletedIds.push(dlqRecord.recordId);
      }
    }

    return deletedIds;
  }

  async getOffset(subscriberId: string, topic: string): Promise<ConsumerOffset | null> {
    const key = `${subscriberId}:${topic}`;
    return this.offsets.offsets.get(key) || null;
  }

  async commitOffset(offset: ConsumerOffset): Promise<void> {
    this.offsets.offsets.set(`${offset.subscriberId}:${offset.topic}`, offset);
  }

  async releaseExpiredClaims(now: Date): Promise<number> {
    let releasedCount = 0;

    for (const [worktreeKey, claim] of this.claims.active.entries()) {
      if (now > claim.expiresAt) {
        this.claims.active.delete(worktreeKey);
        this.claims.byOwner.delete(claim.ownerId);
        releasedCount++;
      }
    }

    return releasedCount;
  }

  async rejectStaleAcknowledgement(acknowledgement: { messageId: string; token: number }): Promise<boolean> {
    // Check if acknowledgement token is stale vs current active claim
    for (const claim of this.claims.active.values()) {
      if (claim.fencingToken > acknowledgement.token) {
        return true; // Reject - token is stale
      }
    }
    return false;
  }

  async recoverFromOffset(
    subscriberId: string,
    topic: string,
    sequence: number
  ): Promise<DeliverableMessage[]> {
    const messages: DeliverableMessage[] = [];

    // Find all pending records at or after sequence
    for (const record of this.records.byId.values()) {
      if (record.status === 'pending') {
        for (const event of record.events) {
          if (event.globalSequence >= sequence) {
            messages.push({
              messageId: event.eventId,
              eventType: event.eventType,
              payloadVersion: '1', // Would come from payload version in real implementation
              payloadHash: event.payloadHash,
              aggregateId: event.aggregateId,
              globalSequence: event.globalSequence,
              occurredAt: event.timestamp,
              commandId: event.commandId,
              correlationId: event.correlationId
            });
          }
        }
      }
    }

    return messages;
  }

  async isDuplicateDelivery(messageId: string): Promise<boolean> {
    return this.deliveries.has(messageId);
  }

  /**
   * Simulation helper for testing
   */
  private async simulateDelivery(message: DeliverableMessage): Promise<void> {
    // Simulate random network failures for testing
    if (Math.random() < 0.2) {
      throw new Error(`Network timeout connecting to broker`);
    }
    if (message.eventType === 'TEST_PERMANENT_ERROR') {
      throw new Error(`SERIALIZATION: Invalid payload format`);
    }
    // Success
  }
}

// Test helpers
export function clearOutboxRepository(repo: InMemoryOutboxRepository): void {
  repo['records'].byId.clear();
  repo['records'].byAggregate.clear();
  repo['claims'].active.clear();
  repo['claims'].byOwner.clear();
  repo['offsets'].offsets.clear();
  repo['deadLetters'].records.clear();
}

export function getAllClaims(repo: InMemoryOutboxRepository): Map<string, BoundedClaim> {
  return new Map(repo['claims'].active);
}

export function getAllOffsets(repo: InMemoryOutboxRepository): Map<string, ConsumerOffset> {
  return new Map(repo['offsets'].offsets);
}
