export type FlowDeckRunStage = 'intake' | 'context' | 'plan' | 'execute' | 'verify' | 'complete';

export type FlowDeckEventType =
  // Run
  | 'run.created' | 'run.started' | 'run.resumed' | 'run.cancelled' | 'run.completed' | 'run.failed'
  // Task
  | 'task.classifying' | 'task.classified'
  // Contract
  | 'contract.created' | 'contract.activated'
  // Stage
  | 'stage.entered' | 'stage.progress' | 'stage.completed' | 'stage.blocked'
  // Plan
  | 'plan.created' | 'plan.updated' | 'plan.drift_detected'
  // Agent
  | 'agent.queued' | 'agent.started' | 'agent.progress' | 'agent.completed' | 'agent.failed' | 'agent.cancelled'
  // Tool
  | 'tool.queued' | 'tool.started' | 'tool.output' | 'tool.completed' | 'tool.failed' | 'tool.cancelled'
  // Model
  | 'model.queued' | 'model.started' | 'model.first_token' | 'model.completed' | 'model.failed' | 'model.cancelled'
  // Verification
  | 'verification.started' | 'verification.check_started' | 'verification.check_completed' | 'verification.completed'
  // Recovery
  | 'recovery.started' | 'recovery.hypothesis_changed' | 'recovery.completed' | 'recovery.circuit_opened'
  // Evidence
  | 'evidence.created'
  // Approval
  | 'approval.required' | 'approval.received'
  // System
  | 'metrics.updated' | 'snapshot' | 'heartbeat';

export interface FlowDeckStreamEvent<TPayload = unknown> {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  runId: string;
  sessionId?: string;
  assignmentId?: string;
  occurredAt: string;
  type: FlowDeckEventType;
  stage: FlowDeckRunStage;
  importance: "debug" | "normal" | "important" | "critical";
  title: string;
  summary?: string;
  payload: TPayload;
  progress?: {
    completed: number;
    total: number;
    unit: "steps" | "checks" | "files" | "assignments";
  };
  metrics?: {
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    toolCalls?: number;
  };
}

export function createStreamEvent<TPayload = unknown>(
  data: Omit<FlowDeckStreamEvent<TPayload>, 'schemaVersion' | 'eventId' | 'occurredAt'> & { eventId?: string; occurredAt?: string }
): FlowDeckStreamEvent<TPayload> {
  return {
    schemaVersion: 1,
    eventId: data.eventId ?? crypto.randomUUID(),
    occurredAt: data.occurredAt ?? new Date().toISOString(),
    ...data,
  };
}

export function isTerminalEvent(event: FlowDeckStreamEvent): boolean {
  return [
    'run.completed',
    'run.failed',
    'run.cancelled',
    'recovery.circuit_opened'
  ].includes(event.type);
}

export function isHighPriorityEvent(event: FlowDeckStreamEvent): boolean {
  return ['important', 'critical'].includes(event.importance);
}

export function normalizeEventType(rawType: string): FlowDeckEventType {
  const validTypes = new Set<string>([
    'run.created', 'run.started', 'run.resumed', 'run.cancelled', 'run.completed', 'run.failed',
    'task.classifying', 'task.classified',
    'contract.created', 'contract.activated',
    'stage.entered', 'stage.progress', 'stage.completed', 'stage.blocked',
    'plan.created', 'plan.updated', 'plan.drift_detected',
    'agent.queued', 'agent.started', 'agent.progress', 'agent.completed', 'agent.failed', 'agent.cancelled',
    'tool.queued', 'tool.started', 'tool.output', 'tool.completed', 'tool.failed', 'tool.cancelled',
    'model.queued', 'model.started', 'model.first_token', 'model.completed', 'model.failed', 'model.cancelled',
    'verification.started', 'verification.check_started', 'verification.check_completed', 'verification.completed',
    'recovery.started', 'recovery.hypothesis_changed', 'recovery.completed', 'recovery.circuit_opened',
    'evidence.created', 'approval.required', 'approval.received',
    'metrics.updated', 'snapshot', 'heartbeat'
  ]);
  if (validTypes.has(rawType)) return rawType as FlowDeckEventType;
  if (rawType.includes('start')) return 'run.started';
  if (rawType.includes('complete')) return 'run.completed';
  if (rawType.includes('cancel')) return 'run.cancelled';
  if (rawType.includes('fail')) return 'run.failed';
  return 'agent.progress';
}
