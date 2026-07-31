import type { IIdempotencyStore } from "./ports";

export class IdempotencyService {
  constructor(private readonly store: IIdempotencyStore) {}

  async isDuplicate(key: string): Promise<boolean> {
    return this.store.isDuplicate(key);
  }

  async markProcessed(key: string, ttlMs?: number): Promise<void> {
    return this.store.markProcessed(key, ttlMs);
  }

  async getResult(key: string): Promise<Record<string, unknown> | null> {
    return this.store.getResult(key);
  }
}
