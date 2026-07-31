export const OutboxStatus = {
  PENDING: "pending",
  DELIVERED: "delivered",
  FAILED: "failed",
  RETRYING: "retrying",
} as const;

export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export interface OutboxEntry {
  id: string;
  eventId: string;
  eventType: string;
  status: OutboxStatus;
  destination?: string;
  correlationId: string;
  causationId?: string;
  aggregateId?: string;
  attemptCount: number;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
  scheduledAt?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface OutboxFilter {
  status?: OutboxStatus;
  destination?: string;
  correlationId?: string;
}

export interface OutboxEntryDTO {
  id: string;
  eventId: string;
  status: string;
  destination: string;
  correlationId: string;
  retryCount: number;
  createdAt: string;
}
