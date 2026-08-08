import { z } from 'zod';
import type { FlowDeckStreamEvent } from './stream-event';

export const FlowDeckRunStageSchema = z.enum(['intake', 'context', 'plan', 'execute', 'verify', 'complete']);

export const FlowDeckEventTypeSchema = z.enum([
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
  'evidence.created',
  'approval.required', 'approval.received',
  'metrics.updated', 'snapshot', 'heartbeat'
]);

export const ProgressSchema = z.object({
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  unit: z.enum(['steps', 'checks', 'files', 'assignments'])
});

export const MetricsSchema = z.object({
  elapsedMs: z.number().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  toolCalls: z.number().int().min(0).optional(),
});

export const FlowDeckStreamEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid().or(z.string().min(1)),
  sequence: z.number().int().min(0),
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  occurredAt: z.string().datetime(),
  type: FlowDeckEventTypeSchema,
  stage: FlowDeckRunStageSchema,
  importance: z.enum(['debug', 'normal', 'important', 'critical']),
  title: z.string().min(1),
  summary: z.string().optional(),
  payload: z.unknown(),
  progress: ProgressSchema.optional(),
  metrics: MetricsSchema.optional(),
}).passthrough(); // allows unknown fields

export function validateStreamEvent(data: unknown): { success: boolean; data?: FlowDeckStreamEvent; error?: string } {
  const result = FlowDeckStreamEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as FlowDeckStreamEvent };
  } else {
    return { success: false, error: result.error.message };
  }
}
