import { describe, it, expect } from 'bun:test';
import { DeterministicScheduler } from '../fake/fake-scheduler';

describe('Runtime Compliance Suite', () => {
  it('validates transition matrix', async () => {
    const scheduler = new DeterministicScheduler();
    let state = 'init';
    scheduler.schedule(async () => { state = 'running'; });
    scheduler.schedule(async () => { state = 'done'; });
    
    await scheduler.runNext();
    expect(state).toBe('running');
    
    await scheduler.runNext();
    expect(state).toBe('done');
  });
  describe('Runtime Lifecycle', () => {
    it('enforces created -> planning -> executing transition', () => {
      let runState = 'created';
      
      const transitionTo = (newState: string) => {
        const validTransitions: Record<string, string[]> = {
          'created': ['planning', 'cancelled'],
          'planning': ['analysing', 'executing', 'failed'],
          'executing': ['verifying', 'recovering', 'failed', 'completed'],
        };
        
        if (!validTransitions[runState].includes(newState)) {
          throw new Error(`Invalid transition from ${runState} to ${newState}`);
        }
        runState = newState;
      };
      
      transitionTo('planning');
      expect(runState).toBe('planning');
      
      transitionTo('executing');
      expect(runState).toBe('executing');
      
      expect(() => transitionTo('created')).toThrow();
    });
  });
});
