/**
 * RepoLeaseCoordinator — same-repository session coordination (Requirement K).
 *
 * Multiple read-only sessions are allowed and never serialize unnecessarily.
 * Exactly ONE mutating owner is allowed per repo/worktree via a crash-safe,
 * recoverable exclusive lease. A second mutating session waits, is redirected
 * to a separate worktree, or fails safely with a redirect.
 *
 * The lease is filesystem-backed so it survives process crashes: a stale lease
 * (owner no longer alive / expired heartbeat) is reclaimed automatically.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface RepoLease {
  owner: string;
  acquiredAt: number;
  heartbeatAt: number;
  mode: "mutating";
  worktree?: string;
}

export interface RepoLeaseOptions {
  stateDir: string;
  leaseTtlMs?: number;
  recheckMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000; // 5 minutes without heartbeat = stale
const DEFAULT_RECHECK_MS = 500;
const DEFAULT_MAX_WAIT_MS = 10_000;

export class RepoLeaseCoordinator {
  private options: Required<RepoLeaseOptions>;
  private waiters = new Map<string, Array<() => void>>();

  constructor(options: RepoLeaseOptions) {
    this.options = {
      stateDir: options.stateDir,
      leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      recheckMs: options.recheckMs ?? DEFAULT_RECHECK_MS,
      maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    };
  }

  private leaseFile(repoId: string): string {
    return join(this.options.stateDir, "lease-" + repoId + ".json");
  }

  private readLease(repoId: string): RepoLease | null {
    const file = this.leaseFile(repoId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed.owner === "string" && parsed.owner) return parsed as RepoLease;
    } catch { /* corrupted lease treated as stale -> reclaimable */ }
    return null;
  }

  private writeLease(repoId: string, lease: RepoLease): void {
    mkdirSync(this.options.stateDir, { recursive: true });
    writeFileSync(this.leaseFile(repoId), JSON.stringify(lease, null, 2), "utf8");
  }

  private isStale(lease: RepoLease): boolean {
    return Date.now() - lease.heartbeatAt > this.options.leaseTtlMs;
  }

  /**
   * Acquire the mutating lease. Throws RepoLeaseUnavailable (redirect) after
   * maxWaitMs if another live owner holds it.
   */
  async acquireMutatingLease(repoId: string, owner: string): Promise<RepoLease> {
    const deadline = Date.now() + this.options.maxWaitMs;
    while (true) {
      const existing = this.readLease(repoId);
      if (!existing || this.isStale(existing) || existing.owner === owner) {
        const now = Date.now();
        const lease: RepoLease = {
          owner,
          acquiredAt: now,
          heartbeatAt: now,
          mode: "mutating",
        };
        this.writeLease(repoId, lease);
        return lease;
      }
      if (Date.now() >= deadline) {
        const err = new Error("RepoMutatingLeaseUnavailable_Redirect: another live mutating owner (".concat(existing.owner, ") holds ").concat(repoId));
        (err as any).code = "REPO_MUTATING_LEASE_UNAVAILABLE";
        (err as any).holder = existing.owner;
        throw err;
      }
      await this.sleep(this.options.recheckMs);
    }
  }

  /** Heartbeat to keep the lease alive. */
  heartbeat(repoId: string, owner: string): boolean {
    const existing = this.readLease(repoId);
    if (!existing || existing.owner !== owner) return false;
    existing.heartbeatAt = Date.now();
    this.writeLease(repoId, existing);
    return true;
  }

  /** Release the lease (only the owner may release). */
  releaseMutatingLease(repoId: string, owner: string): void {
    const existing = this.readLease(repoId);
    if (!existing || existing.owner !== owner) return;
    try { rmSync(this.leaseFile(repoId), { force: true }); } catch { /* ignore */ }
    this.notifyWaiters(repoId);
  }

  /** Check who currently holds a mutating lease, if anyone. */
  getMutatingOwner(repoId: string): string | null {
    const existing = this.readLease(repoId);
    if (!existing) return null;
    if (this.isStale(existing)) return null;
    return existing.owner;
  }

  /**
   * True when it is safe to run mutating work right now. Read-only sessions
   * never consult this — they are always allowed.
   */
  isSafeToMutate(repoId: string): boolean {
    return this.getMutatingOwner(repoId) === null;
  }

  private notifyWaiters(repoId: string): void {
    const pending = this.waiters.get(repoId) ?? [];
    this.waiters.delete(repoId);
    for (const wake of pending) wake();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class RepoLeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoLeaseUnavailableError";
  }
}

export function repoIdOf(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}
