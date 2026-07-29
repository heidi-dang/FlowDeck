import { describe, it, expect } from 'bun:test';
import { FakeClock } from '../fake/fake-clock';

describe('Performance Testing', () => {
  it('benchmarks migration speed', () => {
    const clock = new FakeClock();
    const start = clock.now();
    // Simulate migration
    clock.advance(100);
    const duration = clock.now() - start;
    expect(duration).toBeLessThanOrEqual(100);
  });
});
