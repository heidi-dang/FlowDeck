/**
 * Outbox Delivery Domain - Phase 3C
 * 
 * Exports all outbox types, ports, implementations, and utilities
 */

// Types & Ports
export {
  InMemoryOutboxRepository,
  DEFAULT_RETRY_POLICY,
  calculateBackoff,
  classifyError,
  isRetryable,
  matchesTopic
} from './in-memory-repo.js';

export type {
  BoundedClaim,
  DeliverableMessage,
  OutboxRecord,
  SubscriberConfig,
  DeliveryAttempt,
  RetryPolicy,
  ConsumerOffset,
  DeadLetterRecord
} from './port.js';
