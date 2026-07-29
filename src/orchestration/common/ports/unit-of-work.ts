/**
 * Unit of Work / Transaction port.
 *
 * Dev 1 implements this. Domain code never manually begins, commits,
 * or rolls back transactions.
 */

export interface UnitOfWork {
  /** Execute work inside a single transaction. Returns the work result. */
  execute<T>(work: () => Promise<T>): Promise<T>
}
