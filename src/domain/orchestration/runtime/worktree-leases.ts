/**
 * Worktree Lease Fencing - Phase 3B
 * 
 * Implements distributed worktree ownership with fencing tokens to prevent stale workers
 */

export interface Lease {
  readonly worktreeKey: string;
  readonly ownerId: string;
  readonly acquiredAt: Date;
  expiresAt: Date;
  readonly fencingToken: number; // Monotonically increasing per owner
}

export interface LeasingResult {
  readonly success: boolean;
  readonly lease?: Lease;
  readonly error?: LeasingError;
}

export type LeasingErrorType = 'ALREADY_OWNED' | 'OWNER_MISMATCH' | 'LEASE_EXPIRED' | 'FENCING_VIOLATION';

export class LeasingError extends Error {
  constructor(
    public readonly type: LeasingErrorType,
    worktreeKey: string,
    message: string
  ) {
    super(message);
    this.name = 'LeasingError';
  }
}

/**
 * In-memory lease repository with full fencing support
 * Fencing tokens are now monotonic PER WORKTREE, not per owner
 */
export class InMemoryWorktreeLeaseRepository {
  private leases = new Map<string, Lease>();
  // Token is per-worktree, increments on each acquire regardless of owner
  private worktreeTokens = new Map<string, number>();

  static readonly DEFAULT_TTL_MS = 30000; // 30 second TTL
  static readonly RENEWAL_THRESHOLD_MS = 15000; // Renew if less than 15s remaining

  /**
   * Acquire a lease with atomic fencing token check
   * New: increments worktree-level token for monotonicity
   */
  async acquire(
    worktreeKey: string,
    ownerId: string,
    options?: { ttlMs?: number }
  ): Promise<LeasingResult> {
    const existing = this.leases.get(worktreeKey);

    // Check if already owned by different owner
    if (existing && existing.ownerId !== ownerId) {
      return {
        success: false,
        error: new LeasingError('ALREADY_OWNED', worktreeKey, `Already owned by ${existing.ownerId}`)
      };
    }

    // Increment and assign NEW fencing token for THIS worktree
    const currentToken = this.worktreeTokens.get(worktreeKey) ?? 0;
    const newToken = currentToken + 1;
    this.worktreeTokens.set(worktreeKey, newToken);

    const now = new Date();
    const lease: Lease = {
      worktreeKey,
      ownerId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + (options?.ttlMs ?? InMemoryWorktreeLeaseRepository.DEFAULT_TTL_MS)),
      fencingToken: newToken
    };

    this.leases.set(worktreeKey, lease);

    return { success: true, lease };
  }

  /**
   * Renew an existing lease if still owned by same owner
   * Token remains SAME on renewal (only changes on new acquire)
   */
  async renew(
    worktreeKey: string,
    ownerId: string,
    options?: { ttlMs?: number }
  ): Promise<LeasingResult> {
    const existing = this.leases.get(worktreeKey);

    if (!existing) {
      return {
        success: false,
        error: new LeasingError('LEASE_EXPIRED', worktreeKey, 'No active lease found')
      };
    }

    if (existing.ownerId !== ownerId) {
      return {
        success: false,
        error: new LeasingError('OWNER_MISMATCH', worktreeKey, `Owned by ${existing.ownerId}, not ${ownerId}`)
      };
    }

    // Extend expiration WITHOUT changing token
    const now = new Date();
    existing.expiresAt = new Date(now.getTime() + (options?.ttlMs ?? InMemoryWorktreeLeaseRepository.DEFAULT_TTL_MS));

    return { success: true, lease: { ...existing } };
  }

  /**
   * Release a lease owned by given owner
   */
  async release(worktreeKey: string, ownerId: string): Promise<void> {
    const existing = this.leases.get(worktreeKey);
    
    // Only allow owner or no-owner to release
    if (existing && existing.ownerId === ownerId) {
      this.leases.delete(worktreeKey);
    }
  }

  /**
   * Get current lease if valid
   */
  async getLease(worktreeKey: string): Promise<Lease | undefined> {
    const lease = this.leases.get(worktreeKey);

    if (!lease) {
      return undefined;
    }

    // Check expiration
    if (new Date() > lease.expiresAt) {
      this.leases.delete(worktreeKey);
      return undefined;
    }

    return { ...lease };
  }

  /**
   * Check if owned by specific owner
   */
  async isOwnedBy(worktreeKey: string, ownerId: string): Promise<boolean> {
    const lease = await this.getLease(worktreeKey);
    return !!lease && lease.ownerId === ownerId;
  }

  /**
   * Fencing token validation
   * Rejects operations from stale owners who lost lease but still have old token
   */
  validateFencing(
    worktreeKey: string,
    ownerId: string,
    providedToken?: number
  ): { valid: true } | { valid: false; error: LeasingError } {
    const current = this.leases.get(worktreeKey);

    if (!current) {
      return { valid: false, error: new LeasingError('LEASE_EXPIRED', worktreeKey, 'No active lease found') };
    }

    if (current.ownerId !== ownerId) {
      return {
        valid: false,
        error: new LeasingError('OWNER_MISMATCH', worktreeKey, `Expected ${ownerId}, got ${current.ownerId}`)
      };
    }

    if (providedToken !== undefined && current.fencingToken !== providedToken) {
      return {
        valid: false,
        error: new LeasingError('FENCING_VIOLATION', worktreeKey, `Stale token: expected ${current.fencingToken}, got ${providedToken}`)
      };
    }

    return { valid: true };
  }

  /**
   * Get owner ID if holding lease
   */
  async getOwner(worktreeKey: string): Promise<string | undefined> {
    const lease = await this.getLease(worktreeKey);
    return lease?.ownerId;
  }

  /**
   * Get owner ID if holding lease
   */
}
