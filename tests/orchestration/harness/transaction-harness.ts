export class TransactionHarness {
  constructor(private db: any) {}
  
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.db.execute('BEGIN TRANSACTION');
    try {
      const result = await work();
      this.db.execute('COMMIT');
      return result;
    } catch (e) {
      this.db.execute('ROLLBACK');
      throw e;
    }
  }
}
