export type FaultPoint =
  | 'migration_before_ledger_write'
  | 'migration_after_schema_mutation'
  | 'transaction_before_commit'
  | 'transaction_during_commit'
  | 'event_insert'
  | 'outbox_insert'
  | 'aggregate_update'
  | 'repository_row_decode'
  | 'savepoint_rollback'
  | 'savepoint_release'
  | 'consumer_offset_update'
  | 'projection_update'
  | 'replay_event_decode'
  | 'lease_acquire'
  | 'lease_renew'
  | 'lease_release'
  | 'transaction_rollback'
  | 'outbox_delivery'
  | 'event_rehydrate'
  | 'state_transition'
  | 'schema_migration'
  | 'claim_ownership'
  | 'evidence_validation';

export interface FaultConfig {
  mode: 'before' | 'after';
  action: 'throw' | 'return';
  value: unknown; // Error to throw, or value to return
  times?: number; // How many times to trigger (default: 1)
  onInvocation?: number; // Only trigger on exactly this invocation number
}

export class FaultInjector {
  private faults = new Map<FaultPoint, FaultConfig[]>();
  private invocationHistory = new Map<FaultPoint, number>();

  injectFault(point: FaultPoint, config: FaultConfig): void {
    if (!this.faults.has(point)) {
      this.faults.set(point, []);
    }
    this.faults.get(point)!.push(config);
  }

  clearFault(point: FaultPoint): void {
    this.faults.delete(point);
    this.invocationHistory.delete(point);
  }

  clearAllFaults(): void {
    this.faults.clear();
    this.invocationHistory.clear();
  }

  getHistory(point: FaultPoint): number {
    return this.invocationHistory.get(point) || 0;
  }

  checkFault(point: FaultPoint, mode: 'before' | 'after'): unknown | void {
    const history = (this.invocationHistory.get(point) || 0) + 1;
    if (mode === 'after') {
      // Invocations are counted on 'before', so we don't increment on 'after'
    } else {
      this.invocationHistory.set(point, history);
    }

    const configs = this.faults.get(point);
    if (!configs) return;

    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      if (c.mode !== mode) continue;

      if (c.onInvocation !== undefined && c.onInvocation !== history) {
        continue;
      }

      if (c.times !== undefined) {
        if (c.times <= 0) continue;
        c.times--;
      }

      if (c.action === 'throw') {
        throw c.value;
      } else if (c.action === 'return') {
        return c.value;
      }
    }
  }
}
