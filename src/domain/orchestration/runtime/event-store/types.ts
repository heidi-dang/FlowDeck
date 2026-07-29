export const EVENT_PAYLOAD_VERSIONS = { CURRENT: 1 } as const;
export function createUncommittedEvent(t: string, d: any, id: string, v: number) { return {} as any; }
export interface UncommittedRuntimeEvent<EventType = any> { eventId: string; eventType: string; data: EventType; aggregateId: string; aggregateVersion: number; metadata?: Record<string, unknown>; commandId?: string; createdAt?: Date; }
export interface PersistedRuntimeEvent<EventType = any> { event: EventType; eventId: string; eventType: string; data: EventType; aggregateId: string; aggregateVersion: number; globalSequence: number; timestamp: Date; metadata?: Record<string, unknown>; payload?: unknown; type?: string; correlationId?: string; payloadHash?: string; checksum?: string; createdAt?: Date; committedAt?: Date; [key: string]: unknown; }
export type RuntimeEventPayload = Record<string, unknown>;
export interface RuntimeEventPayloadMap {}
export type RuntimeEventType = string;
export interface RunCreatedEventPayload { runId: string }
export interface RunStartedPlanningEventPayload {}
export interface RunCompletedPlanningEventPayload {}
export interface RunStartedAnalysisEventPayload {}
export interface RunCompletedAnalysisEventPayload {}
export interface RunStartedExecutionEventPayload {}
export interface RunCompletedExecutionEventPayload {}
export interface RunVerifiedEventPayload {}
export interface RunCompletedEventPayload {}
export interface RunFailedEventPayload { error: string }
export interface RunCancelledEventPayload { reason: string }
export interface RunRecoveredEventPayload {}