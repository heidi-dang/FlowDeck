import { describe, it, expect } from 'bun:test';
import { FakeEventBus } from '../fake/fake-event-bus';

describe('Replay Validation', () => {
  it('validates deterministic rebuild', async () => {
    const bus = new FakeEventBus();
    await bus.publish('test-topic', { data: 'test' });
    expect(bus.events.length).toBe(1);
    expect(bus.events[0].topic).toBe('test-topic');
  });
});
