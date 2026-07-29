export const EVENT_PAYLOAD_VERSIONS = { CURRENT: 1 } as const;
export function createUncommittedEvent(_t: string, _d: any, _ag: string, _v: number) { return {} as any; }
export interface UncommittedRuntimeEvent { eventId: string; eventType: string; data: any; aggregateId: string; aggregateVersion: number; metadata?: Record<string, unknown>; commandId?: string; createdAt?: Date; payload?: unknown; }
export interface PersistedRuntimeEvent { [key: string]: any; event: any; eventId: string; aggregateVersion: number; globalSequence: number; timestamp: Date; }
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
