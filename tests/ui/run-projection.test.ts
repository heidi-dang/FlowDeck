import { describe, expect, it } from 'vitest';
import {
  FlowDeckStreamEvent,
  INITIAL_STATE,
  createStreamEvent,
  reduceRunStreamEvent,
} from '../../src/orchestration/streaming';

describe('Run Projection Reducer', () => {
  it('should initialize correctly', () => {
    expect(INITIAL_STATE.runId).toBeNull();
  });

  it('should handle sequence gaps by taking later state if sequence is higher', () => {
    const event1: FlowDeckStreamEvent = createStreamEvent({
      eventId: '1',
      sequence: 1,
      runId: 'r1',
      type: 'run.started',
      stage: 'intake',
      importance: 'normal',
      title: 'Run Started',
      payload: { runId: 'r1' },
    });
    const event2: FlowDeckStreamEvent = createStreamEvent({
      eventId: '2',
      sequence: 2,
      runId: 'r1',
      type: 'stage.entered',
      stage: 'plan',
      importance: 'normal',
      title: 'Plan Stage',
      payload: { stage: 'plan' },
    });

    let state = reduceRunStreamEvent(INITIAL_STATE, event1);
    expect(state.runId).toBe('r1');
    expect(state.currentStage).toBe('intake');

    state = reduceRunStreamEvent(state, event2);
    expect(state.currentStage).toBe('plan');
  });

  it('should ignore duplicate or old events (idempotency)', () => {
    const event1: FlowDeckStreamEvent = createStreamEvent({
      eventId: '1',
      sequence: 1,
      runId: 'r1',
      type: 'run.started',
      stage: 'intake',
      importance: 'normal',
      title: 'Run Started',
      payload: { runId: 'r1' },
    });
    let state = reduceRunStreamEvent(INITIAL_STATE, event1);
    const originalState = state;

    state = reduceRunStreamEvent(state, event1);
    expect(state).toBe(originalState);
  });

  it('should manage run identity, title, and current stage updates', () => {
    const e: FlowDeckStreamEvent = createStreamEvent({
      eventId: '1',
      sequence: 1,
      runId: 'r1',
      type: 'run.started',
      stage: 'intake',
      importance: 'normal',
      title: 'Test Run',
      payload: { runId: 'r1', title: 'Test Run' },
    });
    const s = reduceRunStreamEvent(INITIAL_STATE, e);
    expect(s.title).toBe('Test Run');
    expect(s.runId).toBe('r1');
    expect(s.currentStage).toBe('intake');
  });

  it('should support stage states and transitions', () => {
    const event1: FlowDeckStreamEvent = createStreamEvent({
      eventId: '1',
      sequence: 1,
      runId: 'r1',
      type: 'run.started',
      stage: 'intake',
      importance: 'normal',
      title: 'Started',
      payload: { runId: 'r1' },
    });
    const event2: FlowDeckStreamEvent = createStreamEvent({
      eventId: '2',
      sequence: 2,
      runId: 'r1',
      type: 'stage.entered',
      stage: 'context',
      importance: 'normal',
      title: 'Context',
      payload: { stage: 'context' },
    });

    let state = reduceRunStreamEvent(INITIAL_STATE, event1);
    expect(state.stageStates.intake).toBe('active');

    state = reduceRunStreamEvent(state, event2);
    expect(state.stageStates.intake).toBe('completed');
    expect(state.stageStates.context).toBe('active');
  });

  it('should manage agent activity states and tool executions', () => {
    const event1: FlowDeckStreamEvent = createStreamEvent({
      eventId: '1',
      sequence: 1,
      runId: 'r1',
      type: 'agent.started',
      stage: 'execute',
      importance: 'normal',
      title: 'Coding Task',
      payload: { id: 'a1', agentId: 'agent-1', responsibility: 'coding', operation: 'Thinking' },
    });
    const event2: FlowDeckStreamEvent = createStreamEvent({
      eventId: '2',
      sequence: 2,
      runId: 'r1',
      type: 'tool.started',
      stage: 'execute',
      importance: 'normal',
      title: 'Read file',
      payload: { id: 't1', agentId: 'a1', toolName: 'read_file', args: {} },
    });

    let state = reduceRunStreamEvent(INITIAL_STATE, event1);
    expect(state.agentActivities['a1']).toBeDefined();

    state = reduceRunStreamEvent(state, event2);
    expect(state.toolExecutions['t1']).toBeDefined();
    expect(state.agentActivities['a1'].toolsUsed).toBe(1);
  });
});
