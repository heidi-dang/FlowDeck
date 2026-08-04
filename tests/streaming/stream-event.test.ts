import { describe, expect, it } from 'bun:test';
import { createStreamEvent, isTerminalEvent, isHighPriorityEvent } from '../../src/orchestration/streaming/stream-event';
import { validateStreamEvent } from '../../src/orchestration/streaming/stream-event-schema';

describe('StreamEvent validation and helpers', () => {
  const baseEvent = {
    schemaVersion: 1 as const,
    sequence: 1,
    runId: 'run-123',
    type: 'run.started' as const,
    stage: 'intake' as const,
    importance: 'normal' as const,
    title: 'Run started',
    payload: {},
  };

  it('createStreamEvent fills defaults', () => {
    const event = createStreamEvent(baseEvent);
    expect(event.eventId).toBeDefined();
    expect(event.occurredAt).toBeDefined();
    expect(event.schemaVersion).toBe(1);
    expect(event.type).toBe('run.started');
  });

  it('validateStreamEvent validates successfully', () => {
    const event = createStreamEvent(baseEvent);
    const result = validateStreamEvent(event);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('validateStreamEvent fails on missing required fields', () => {
    const invalidEvent = { ...baseEvent };
    // @ts-ignore
    delete invalidEvent.type;
    const result = validateStreamEvent(invalidEvent);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('isTerminalEvent identifies terminal events', () => {
    expect(isTerminalEvent(createStreamEvent({ ...baseEvent, type: 'run.completed' }))).toBe(true);
    expect(isTerminalEvent(createStreamEvent({ ...baseEvent, type: 'run.failed' }))).toBe(true);
    expect(isTerminalEvent(createStreamEvent({ ...baseEvent, type: 'run.cancelled' }))).toBe(true);
    expect(isTerminalEvent(createStreamEvent({ ...baseEvent, type: 'recovery.circuit_opened' }))).toBe(true);
    expect(isTerminalEvent(createStreamEvent({ ...baseEvent, type: 'run.started' }))).toBe(false);
  });

  it('isHighPriorityEvent identifies important/critical events', () => {
    expect(isHighPriorityEvent(createStreamEvent({ ...baseEvent, importance: 'important' }))).toBe(true);
    expect(isHighPriorityEvent(createStreamEvent({ ...baseEvent, importance: 'critical' }))).toBe(true);
    expect(isHighPriorityEvent(createStreamEvent({ ...baseEvent, importance: 'normal' }))).toBe(false);
    expect(isHighPriorityEvent(createStreamEvent({ ...baseEvent, importance: 'debug' }))).toBe(false);
  });

  it('schema preserves unknown fields', () => {
    const event = createStreamEvent({ ...baseEvent, someUnknownField: 'value' } as any);
    const result = validateStreamEvent(event);
    expect(result.success).toBe(true);
    expect((result.data as any).someUnknownField).toBe('value');
  });

  it('supports all types (serialization/validation)', () => {
    const types = [
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
    ];

    for (const t of types) {
      const e = createStreamEvent({ ...baseEvent, type: t as any });
      const r = validateStreamEvent(e);
      expect(r.success).toBe(true);
    }
  });

  it('validates progress properly', () => {
    const validProgress = createStreamEvent({
      ...baseEvent,
      progress: { completed: 1, total: 10, unit: 'steps' }
    });
    expect(validateStreamEvent(validProgress).success).toBe(true);

    const invalidProgress = createStreamEvent({
      ...baseEvent,
      progress: { completed: -1, total: 10, unit: 'steps' }
    });
    expect(validateStreamEvent(invalidProgress).success).toBe(false);
  });

  it('validates sequence constraints', () => {
    const validSequence = createStreamEvent({
      ...baseEvent,
      sequence: 0,
    });
    expect(validateStreamEvent(validSequence).success).toBe(true);

    const invalidSequence = createStreamEvent({
      ...baseEvent,
      sequence: -1, // Int and Min 0
    });
    expect(validateStreamEvent(invalidSequence).success).toBe(false);
  });
});
