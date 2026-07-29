import { describe, it, expect } from 'bun:test';
import { FaultInjector } from '../fault/fault-injector';

describe('Chaos Testing', () => {
  it('handles process crash during transaction', async () => {
    const injector = new FaultInjector();
    injector.injectFault('process_crash');
    
    let caught = false;
    try {
      await injector.checkFault('process_crash');
    } catch (e: any) {
      caught = true;
      expect(e.message).toBe('Injected fault: process_crash');
    }
    expect(caught).toBe(true);
  });
});
