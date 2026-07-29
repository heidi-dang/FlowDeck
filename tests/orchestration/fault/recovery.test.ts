import { describe, it, expect } from 'bun:test';
import { FaultInjector, type FaultPoint } from './fault-injector';

describe('Fault Injection & Recovery Harness', () => {
  it('intercepts execution and triggers invariant recovery', async () => {
    const injector = new FaultInjector();
    injector.injectFault('transaction_during_commit', {
      mode: 'before',
      action: 'throw',
      value: new Error('Simulated commit failure')
    });
    
    let recovered = false;
    let executionState = 'running';
    
    try {
      await injector.checkFault('transaction_during_commit', 'before');
      executionState = 'completed';
    } catch (err: any) {
      if (err.message.includes('Simulated commit failure')) {
        recovered = true;
        executionState = 'recovering';
      } else {
        throw err;
      }
    }
    
    expect(recovered).toBe(true);
    expect(executionState).toBe('recovering');
    expect(injector.getHistory('transaction_during_commit')).toBe(1);
    
    // Simulate successful recovery
    injector.clearAllFaults();
    await injector.checkFault('transaction_during_commit', 'before');
    expect(injector.getHistory('transaction_during_commit')).toBe(1);
  });

  it('supports inject N times', async () => {
    const injector = new FaultInjector();
    injector.injectFault('event_insert', {
      mode: 'before',
      action: 'throw',
      value: new Error('Flaky DB'),
      times: 2
    });

    let failures = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await injector.checkFault('event_insert', 'before');
      } catch (e) {
        failures++;
      }
    }

    expect(failures).toBe(2);
    expect(injector.getHistory('event_insert')).toBe(3);
  });

  it('supports inject on named invocation', async () => {
    const injector = new FaultInjector();
    injector.injectFault('outbox_insert', {
      mode: 'before',
      action: 'throw',
      value: new Error('Fail on 2nd try'),
      onInvocation: 2
    });

    await injector.checkFault('outbox_insert', 'before'); // 1st
    let failed = false;
    try {
      await injector.checkFault('outbox_insert', 'before'); // 2nd
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    await injector.checkFault('outbox_insert', 'before'); // 3rd
  });
});
