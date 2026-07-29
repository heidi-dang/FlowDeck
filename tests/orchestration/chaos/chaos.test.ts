import { describe, it, expect } from 'bun:test';
import { FaultInjector } from '../fault/fault-injector';

describe('Chaos Testing', () => {
  it('handles process crash during transaction', async () => {
    const injector = new FaultInjector();
    injector.injectFault('transaction_during_commit', { mode: 'before', action: 'throw', value: new Error('Injected fault: transaction_during_commit') });
    
    let caught = false;
    try {
      await injector.checkFault('transaction_during_commit', 'before');
    } catch (e: any) {
      caught = true;
      expect(e.message).toBe('Injected fault: transaction_during_commit');
    }
    expect(caught).toBe(true);
  });
});
