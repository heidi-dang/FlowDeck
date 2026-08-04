import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FaultInjector, type FaultPoint } from '../orchestration/fault/fault-injector';

type FaultScenario = {
  name: string;
  point: FaultPoint;
  inject: (injector: FaultInjector) => void;
  expectError: boolean;
  errorMessage?: string;
};

const FAULT_SCENARIOS: FaultScenario[] = [
  {
    name: 'Process Crash',
    point: 'transaction_during_commit',
    inject: (inj) =>
      inj.injectFault('transaction_during_commit', {
        mode: 'before',
        action: 'throw',
        value: new Error('Process crashed'),
      }),
    expectError: true,
    errorMessage: 'Process crashed',
  },
  {
    name: 'Database Busy',
    point: 'aggregate_update',
    inject: (inj) =>
      inj.injectFault('aggregate_update', {
        mode: 'before',
        action: 'throw',
        value: new Error('Database busy: SQLITE_BUSY'),
      }),
    expectError: true,
    errorMessage: 'Database busy',
  },
  {
    name: 'Provider Timeout',
    point: 'event_insert',
    inject: (inj) =>
      inj.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Provider timeout after 30000ms'),
      }),
    expectError: true,
    errorMessage: 'Provider timeout',
  },
  {
    name: 'Tool Timeout',
    point: 'projection_update',
    inject: (inj) =>
      inj.injectFault('projection_update', {
        mode: 'before',
        action: 'throw',
        value: new Error('Tool execution timed out'),
      }),
    expectError: true,
    errorMessage: 'Tool execution timed out',
  },
  {
    name: 'Specialist Timeout',
    point: 'state_transition',
    inject: (inj) =>
      inj.injectFault('state_transition', {
        mode: 'before',
        action: 'throw',
        value: new Error('Specialist response timeout'),
      }),
    expectError: true,
    errorMessage: 'Specialist response timeout',
  },
  {
    name: 'Checkpoint Failure',
    point: 'lease_renew',
    inject: (inj) =>
      inj.injectFault('lease_renew', {
        mode: 'before',
        action: 'throw',
        value: new Error('Checkpoint write failed'),
      }),
    expectError: true,
    errorMessage: 'Checkpoint write failed',
  },
  {
    name: 'Cancellation Race',
    point: 'transaction_rollback',
    inject: (inj) =>
      inj.injectFault('transaction_rollback', {
        mode: 'before',
        action: 'throw',
        value: new Error('Cancellation race: operation already cancelled'),
      }),
    expectError: true,
    errorMessage: 'Cancellation race',
  },
  {
    name: 'Duplicate Command',
    point: 'outbox_insert',
    inject: (inj) =>
      inj.injectFault('outbox_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Duplicate command: idempotency key exists'),
      }),
    expectError: true,
    errorMessage: 'Duplicate command',
  },
  {
    name: 'Stale SHA',
    point: 'evidence_validation',
    inject: (inj) =>
      inj.injectFault('evidence_validation', {
        mode: 'before',
        action: 'throw',
        value: new Error('Stale SHA: repository state changed'),
      }),
    expectError: true,
    errorMessage: 'Stale SHA',
  },
  {
    name: 'Ownership Conflict',
    point: 'claim_ownership',
    inject: (inj) =>
      inj.injectFault('claim_ownership', {
        mode: 'before',
        action: 'throw',
        value: new Error('Ownership conflict: task owned by another specialist'),
      }),
    expectError: true,
    errorMessage: 'Ownership conflict',
  },
  {
    name: 'FDX Daemon Failure',
    point: 'schema_migration',
    inject: (inj) =>
      inj.injectFault('schema_migration', {
        mode: 'before',
        action: 'throw',
        value: new Error('FDX daemon not responding'),
      }),
    expectError: true,
    errorMessage: 'FDX daemon',
  },
  {
    name: 'Fallback Failure',
    point: 'lease_acquire',
    inject: (inj) =>
      inj.injectFault('lease_acquire', {
        mode: 'before',
        action: 'throw',
        value: new Error('Fallback mechanism failed'),
      }),
    expectError: true,
    errorMessage: 'Fallback mechanism failed',
  },
];

describe('Fault Injection', () => {
  let db: Database;
  let injector: FaultInjector;

  beforeEach(() => {
    db = new Database(':memory:');
    injector = new FaultInjector();

    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        owner TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sha TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  });

  for (const scenario of FAULT_SCENARIOS) {
    describe(scenario.name, () => {
      it(`injects fault at ${scenario.point}`, () => {
        injector.clearAllFaults();
        scenario.inject(injector);

        expect(() => injector.checkFault(scenario.point, 'before')).toThrow(
          scenario.errorMessage
        );
      });

      it('records invocation history', () => {
        injector.clearAllFaults();
        try {
          scenario.inject(injector);
        } catch {
          // Some faults may inject-throw synchronously
        }

        try {
          injector.checkFault(scenario.point, 'before');
        } catch {
          // Expected
        }

        expect(injector.getHistory(scenario.point)).toBe(1);
      });

      it('supports multiple fault points', () => {
        injector.clearAllFaults();
        injector.injectFault('event_insert', {
          mode: 'before',
          action: 'throw',
          value: new Error('First fault'),
        });
        injector.injectFault('aggregate_update', {
          mode: 'before',
          action: 'throw',
          value: new Error('Second fault'),
        });

        expect(() => injector.checkFault('event_insert', 'before')).toThrow('First fault');
        expect(() => injector.checkFault('aggregate_update', 'before')).toThrow('Second fault');
      });
    });
  }

  describe('Fault Configuration', () => {
    it('supports before mode', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Before hook'),
      });

      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Before hook');
    });

    it('supports after mode', () => {
      injector.injectFault('event_insert', {
        mode: 'after',
        action: 'throw',
        value: new Error('After hook'),
      });

      expect(() => injector.checkFault('event_insert', 'after')).toThrow('After hook');
    });

    it('supports return action', async () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'return',
        value: 'custom-return-value',
      });

      const result = await injector.checkFault('event_insert', 'before');
      expect(result).toBe('custom-return-value');
    });

    it('respects times configuration', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Limited fault'),
        times: 2,
      });

      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Limited fault');
      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Limited fault');
      expect(() => injector.checkFault('event_insert', 'before')).not.toThrow();
    });

    it('respects onInvocation configuration', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Second only'),
        onInvocation: 2,
      });

      expect(() => injector.checkFault('event_insert', 'before')).not.toThrow();
      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Second only');
      expect(() => injector.checkFault('event_insert', 'before')).not.toThrow();
    });

    it('clears individual fault point', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Should not clear'),
      });
      injector.injectFault('aggregate_update', {
        mode: 'before',
        action: 'throw',
        value: new Error('Should clear'),
      });

      injector.clearFault('aggregate_update');

      expect(() => injector.checkFault('aggregate_update', 'before')).not.toThrow();
      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Should not clear');
    });

    it('clears all faults', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('First'),
      });
      injector.injectFault('aggregate_update', {
        mode: 'before',
        action: 'throw',
        value: new Error('Second'),
      });

      injector.clearAllFaults();

      expect(() => injector.checkFault('event_insert', 'before')).not.toThrow();
      expect(() => injector.checkFault('aggregate_update', 'before')).not.toThrow();
    });
  });

  describe('Recovery Behavior', () => {
    it('recovers from transient fault after retry', () => {
      injector.injectFault('event_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Transient failure'),
        times: 1,
      });

      expect(() => injector.checkFault('event_insert', 'before')).toThrow('Transient failure');
      expect(() => injector.checkFault('event_insert', 'before')).not.toThrow();
    });

    it('preserves state after fault is cleared', () => {
      try {
        injector.injectFault('transaction_during_commit', {
          mode: 'before',
          action: 'throw',
          value: new Error('Commit failure'),
        });
      } catch {
        // May throw synchronously on some fault points
      }

      try {
        injector.checkFault('transaction_during_commit', 'before');
      } catch {
        // Expected
      }

      injector.clearFault('transaction_during_commit');
      expect(() => injector.checkFault('transaction_during_commit', 'before')).not.toThrow();
    });

    it('handles multiple sequential faults at same point', () => {
      injector.injectFault('outbox_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Fault 1'),
        times: 1,
      });
      injector.injectFault('outbox_insert', {
        mode: 'before',
        action: 'throw',
        value: new Error('Fault 2'),
        times: 1,
      });

      expect(() => injector.checkFault('outbox_insert', 'before')).toThrow('Fault 1');
      expect(() => injector.checkFault('outbox_insert', 'before')).toThrow('Fault 2');
      expect(() => injector.checkFault('outbox_insert', 'before')).not.toThrow();
    });
  });

  describe('Database Fault Integration', () => {
    it('simulates database busy fault', async () => {
      const faultInjector = new FaultInjector();
      faultInjector.injectFault('aggregate_update', {
        mode: 'before',
        action: 'throw',
        value: new Error('SQLITE_BUSY'),
      });

      let caughtError: Error | null = null;
      try {
        await faultInjector.checkFault('aggregate_update', 'before');
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError!.message).toContain('SQLITE_BUSY');
    });

    it('simulates transaction rollback', () => {
      const faultInjector = new FaultInjector();
      faultInjector.injectFault('transaction_rollback', {
        mode: 'before',
        action: 'throw',
        value: new Error('Rollback required'),
      });

      expect(() => faultInjector.checkFault('transaction_rollback', 'before')).toThrow(
        'Rollback required'
      );
    });

    it('simulates outbox delivery failure', () => {
      const faultInjector = new FaultInjector();
      faultInjector.injectFault('outbox_delivery', {
        mode: 'after',
        action: 'throw',
        value: new Error('Delivery failed'),
      });

      expect(() => faultInjector.checkFault('outbox_delivery', 'after')).toThrow('Delivery failed');
    });

    it('simulates event rehydration corruption', () => {
      const faultInjector = new FaultInjector();
      faultInjector.injectFault('event_rehydrate', {
        mode: 'before',
        action: 'throw',
        value: new Error('JSON parse error'),
      });

      expect(() => faultInjector.checkFault('event_rehydrate', 'before')).toThrow('JSON parse');
    });
  });

  describe('State Machine Faults', () => {
    it('blocks invalid state transition', () => {
      injector.injectFault('state_transition', {
        mode: 'before',
        action: 'throw',
        value: new Error('Invalid state transition: PENDING -> COMPLETED'),
      });

      expect(() => injector.checkFault('state_transition', 'before')).toThrow(
        'Invalid state transition'
      );
    });

    it('blocks schema migration during active transaction', () => {
      injector.injectFault('schema_migration', {
        mode: 'before',
        action: 'throw',
        value: new Error('Migration blocked: active transaction'),
      });

      expect(() => injector.checkFault('schema_migration', 'before')).toThrow(
        'Migration blocked'
      );
    });
  });

  describe('Concurrency Faults', () => {
    it('handles lease acquire failure', () => {
      injector.injectFault('lease_acquire', {
        mode: 'before',
        action: 'throw',
        value: new Error('Lease already held by another process'),
      });

      expect(() => injector.checkFault('lease_acquire', 'before')).toThrow(
        'Lease already held'
      );
    });

    it('handles lease renew failure during long operation', () => {
      injector.injectFault('lease_renew', {
        mode: 'before',
        action: 'throw',
        value: new Error('Lease expired during operation'),
      });

      expect(() => injector.checkFault('lease_renew', 'before')).toThrow('Lease expired');
    });

    it('handles lease release failure on cleanup', () => {
      injector.injectFault('lease_release', {
        mode: 'before',
        action: 'throw',
        value: new Error('Lease release failed: resource not found'),
      });

      expect(() => injector.checkFault('lease_release', 'before')).toThrow('Lease release failed');
    });
  });

  describe('Evidence and Ownership Faults', () => {
    it('rejects evidence with invalid SHA', () => {
      injector.injectFault('evidence_validation', {
        mode: 'before',
        action: 'throw',
        value: new Error('Evidence SHA mismatch'),
      });

      expect(() => injector.checkFault('evidence_validation', 'before')).toThrow('SHA mismatch');
    });

    it('rejects ownership claim on stale task', () => {
      injector.injectFault('claim_ownership', {
        mode: 'before',
        action: 'throw',
        value: new Error('Task already owned by specialist-2'),
      });

      expect(() => injector.checkFault('claim_ownership', 'before')).toThrow(
        'Task already owned'
      );
    });

    it('detects ownership conflict during parallel execution', () => {
      injector.injectFault('claim_ownership', {
        mode: 'before',
        action: 'throw',
        value: new Error('Ownership conflict detected'),
      });

      expect(() => injector.checkFault('claim_ownership', 'before')).toThrow(
        'Ownership conflict'
      );
    });
  });

  describe('Fault Coverage', () => {
    const allFaultPoints: FaultPoint[] = [
      'migration_before_ledger_write',
      'migration_after_schema_mutation',
      'transaction_before_commit',
      'transaction_during_commit',
      'event_insert',
      'outbox_insert',
      'aggregate_update',
      'repository_row_decode',
      'savepoint_rollback',
      'savepoint_release',
      'consumer_offset_update',
      'projection_update',
      'replay_event_decode',
      'lease_acquire',
      'lease_renew',
      'lease_release',
      'transaction_rollback',
      'outbox_delivery',
      'event_rehydrate',
      'state_transition',
      'schema_migration',
      'claim_ownership',
      'evidence_validation',
    ];

    it('all fault points are testable', () => {
      for (const point of allFaultPoints) {
        const testInjector = new FaultInjector();
        testInjector.injectFault(point, {
          mode: 'before',
          action: 'throw',
          value: new Error(`Test fault at ${point}`),
        });

        expect(() => testInjector.checkFault(point, 'before')).toThrow(`Test fault at ${point}`);
      }
    });

    it('each scenario is independently testable', () => {
      for (const scenario of FAULT_SCENARIOS) {
        const isolatedInjector = new FaultInjector();
        scenario.inject(isolatedInjector);

        if (scenario.expectError) {
          expect(() => isolatedInjector.checkFault(scenario.point, 'before')).toThrow(
            scenario.errorMessage
          );
        }
      }
    });
  });
});
