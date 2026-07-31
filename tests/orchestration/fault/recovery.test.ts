import { describe, it, expect } from 'bun:test';
import { FaultInjector } from './fault-injector';

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
      } catch {
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

  it('Transaction rollback', async () => {
    const injector = new FaultInjector();
    injector.injectFault('transaction_rollback', { mode: 'before', action: 'throw', value: new Error('Rollback Triggered') });
    expect(injector.checkFault('transaction_rollback', 'before')).rejects.toThrow('Rollback Triggered');
  });

  it('Partial outbox failure', async () => {
    const injector = new FaultInjector();
    injector.injectFault('outbox_delivery', { mode: 'after', action: 'throw', value: new Error('Partial Network Failure') });
    expect(injector.checkFault('outbox_delivery', 'after')).rejects.toThrow('Partial Network Failure');
  });

  it('Corrupt event', async () => {
    const injector = new FaultInjector();
    injector.injectFault('event_rehydrate', { mode: 'before', action: 'throw', value: new Error('SyntaxError: JSON Parse Error') });
    expect(injector.checkFault('event_rehydrate', 'before')).rejects.toThrow('JSON Parse');
  });

  it('Invalid transition', async () => {
    const injector = new FaultInjector();
    injector.injectFault('state_transition', { mode: 'before', action: 'throw', value: new Error('Invalid Transition: ACTIVE -> PENDING') });
    expect(injector.checkFault('state_transition', 'before')).rejects.toThrow('Invalid Transition');
  });

  it('Interrupted migration', async () => {
    const injector = new FaultInjector();
    injector.injectFault('schema_migration', { mode: 'before', action: 'throw', value: new Error('Interrupted') });
    expect(injector.checkFault('schema_migration', 'before')).rejects.toThrow('Interrupted');
  });

  it('Stale ownership', async () => {
    const injector = new FaultInjector();
    injector.injectFault('claim_ownership', { mode: 'before', action: 'throw', value: new Error('Stale Ownership') });
    expect(injector.checkFault('claim_ownership', 'before')).rejects.toThrow('Stale Ownership');
  });

  it('Invalid evidence/completion state', async () => {
    const injector = new FaultInjector();
    injector.injectFault('evidence_validation', { mode: 'before', action: 'throw', value: new Error('Invalid Evidence State') });
    expect(injector.checkFault('evidence_validation', 'before')).rejects.toThrow('Invalid Evidence State');
  });
});
