/**
 * Outbox Delivery Domain - Phase 3C
 * 
 * Exports all outbox types, ports, implementations, and utilities
 */

// Types & Ports
export {
  InMemoryOutboxRepository,
  matchesTopic
} from './in-memory-repo';

// Utilities (re-exported from port)
export { 
  DEFAULT_RETRY_POLICY,
  calculateBackoff,
  classifyError,
  isRetryable
} from './port';

export type {
  BoundedClaim,
  DeliverableMessage,
  OutboxRecord,
  SubscriberConfig,
  DeliveryAttempt,
  RetryPolicy,
  ConsumerOffset,
  DeadLetterRecord
} from './port';
