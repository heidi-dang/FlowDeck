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
});
