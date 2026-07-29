/** Domain ports for runtime execution persistence. */
export interface TaskRunRecord {
  runId: string; contractId: string; strategy: string; state: string
  aggregateVersion: number; baselineSha: string
  currentSha: string | null; verificationSha: string | null; completionSha: string | null
  repoBranch: string; workingTreeClean: boolean
  previousRunId: string | null; createdAt: string; startedAt: string | null; completedAt: string | null
}

export interface RunRequirementRecord {
  id: string; runId: string; requirementId: string; status: string
  startedAt: string | null; completedAt: string | null
}

export interface RunAcceptanceCriterionRecord {
  id: string; runId: string; criterionId: string; status: string
  verifiedAt: string | null; verifiedBy: string | null; failureReason: string | null
}

export interface AssignmentRecord {
  id: string; runId: string; agentId: string; description: string; status: string
  isRequired: boolean; priority: number; createdAt: string
  startedAt: string | null; completedAt: string | null; durationMs: number | null
  createdBy: string; attemptNumber: number; maxAttempts: number; errorMessage: string | null
}

export interface SessionRecord {
  id: string; runId: string; assignmentId: string | null; agentId: string
  parentSessionId: string | null; depth: number; status: string
  toolCalls: number; delegations: number; durationMs: number | null
  startedAt: string; completedAt: string | null; errorMessage: string | null
}

export interface ContextItemRecord {
  id: string; runId: string; sessionId: string | null; source: string; priority: number
  category: string; contentType: string; content: string | null
  immutableRef: string | null; refType: string | null
  contentHash: string; tokenEstimate: number; isSummarised: boolean
  createdAt: string; expiresAt: string | null
}

export interface EventRecord {
  globalSequence: number; eventId: string; eventType: string; eventVersion: number
  causationId: string | null; correlationId: string | null
  aggregateType: string; aggregateId: string; aggregateVersion: number
  timestamp: string; data: string; metadata: string
}

export interface OutboxRecord {
  id: string; eventId: string; eventType: string; aggregateId: string; data: string
  status: string; retryCount: number; lastError: string | null
  nextRetryTs: number | null; idempotencyKey: string; sourceComponent: string; createdTs: number
}

export interface DeliveryRecord {
  id: string; outboxId: string; subscriberId: string; status: string
  deliveryAttempts: number; nextRetryTs: number | null
  lastError: string | null; deliveredAt: string | null; createdTs: number
}

export interface ConsumerOffsetRecord {
  subscriberId: string; lastProcessedSequence: number; lastProcessedAt: string
  status: string; pausedUntil: string | null; blockedByEventId: string | null
}

export interface TaskRunRepository {
  insertRun(record: TaskRunRecord): Promise<TaskRunRecord>
  getRun(id: string): Promise<TaskRunRecord | null>
  updateState(runId: string, state: string, expectedVersion: number): Promise<void>
  updateSha(runId: string, sha: string): Promise<void>
  insertRunRequirement(record: RunRequirementRecord): Promise<RunRequirementRecord>
  getRunRequirements(runId: string): Promise<RunRequirementRecord[]>
  insertRunCriterion(record: RunAcceptanceCriterionRecord): Promise<RunAcceptanceCriterionRecord>
  getRunCriteria(runId: string): Promise<RunAcceptanceCriterionRecord[]>
}

export interface AssignmentRepository {
  insertAssignment(record: AssignmentRecord): Promise<AssignmentRecord>
  getAssignmentsByRun(runId: string): Promise<AssignmentRecord[]>
  updateStatus(id: string, status: string): Promise<void>
}

export interface SessionRepository {
  insertSession(record: SessionRecord): Promise<SessionRecord>
  getSession(id: string): Promise<SessionRecord | null>
  getSessionsByRun(runId: string): Promise<SessionRecord[]>
}

export interface ContextRepository {
  insertContextItem(record: ContextItemRecord): Promise<ContextItemRecord>
  getContextItemsByRun(runId: string): Promise<ContextItemRecord[]>
}

export interface EventStore {
  appendEvent(event: EventRecord): Promise<EventRecord>
  getEventsByAggregate(aggregateType: string, aggregateId: string): Promise<EventRecord[]>
  getMaxAggregateVersion(aggregateType: string, aggregateId: string): Promise<number>
  appendEventWithOutbox(event: EventRecord, outbox: OutboxRecord): Promise<{ event: EventRecord; outbox: OutboxRecord }>
}

export interface OutboxRepository {
  insertOutbox(record: OutboxRecord): Promise<OutboxRecord>
  getPendingOutbox(): Promise<OutboxRecord[]>
}

export interface SubscriberRepository {
  getSubscribers(): Promise<{ id: string; name: string; subscriptionType: string; eventTypes: string; isRequired: boolean }[]>
}

export interface DeliveryRepository {
  insertDelivery(record: DeliveryRecord): Promise<DeliveryRecord>
  claimDelivery(workerId: string): Promise<DeliveryRecord | null>
}

export interface ConsumerOffsetRepository {
  getOffset(subscriberId: string): Promise<ConsumerOffsetRecord | null>
  advanceOffset(subscriberId: string, sequence: number): Promise<void>
}
