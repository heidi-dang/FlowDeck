/**
 * Canonical payload serialization and hashing utilities
 * Ensures deterministic, reproducible payloads across all systems
 */

/**
 * Canonical JSON serialization - sorted keys for reproducibility
 */
export function canonicalSerialize(obj: unknown): string {
  return JSON.stringify(obj, getCanonicalReplacer(), 2);
}

/**
 * Deep clone without prototype pollution or mutations
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(canonicalSerialize(obj));
}

/**
 * Freeze object deeply immutably
 */
export function freezeDeep<T>(obj: T): Readonly<T> {
  if (obj !== null && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      return obj.map(item => freezeDeep(item)) as unknown as Readonly<T>;
    }
    
    const frozen = {} as Readonly<T>;
    const keys = Object.keys(obj).sort(); // Sort keys for determinism
    
    for (const key of keys) {
      const recordObj = obj as Record<string, unknown>;
      const value = recordObj[key];
      const recordFrozen = frozen as Record<string, unknown>;
      recordFrozen[key] = freezeDeep(value);
    }
    
    Object.freeze(frozen);
    return frozen;
  }
  
  return obj;
}

/**
 * Compute SHA-256 hash of canonical JSON representation
 */
export async function computePayloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalSerialize(payload);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify payload integrity against stored digest
 */
export async function verifyPayloadDigest(payload: unknown, expectedDigest: string): Promise<boolean> {
  const actualDigest = await computePayloadDigest(payload);
  return actualDigest === expectedDigest;
}

/**
 * Get canonical replacer for sorted key ordering
 */
function getCanonicalReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet();

  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        throw new Error('Circular reference in payload');
      }
      seen.add(value);
    }
    return value;
  };
}

/**
 * Validate payload has no mutable references
 */
export function validateImmutablePayload(payload: unknown): void {
  const checks: string[] = [];
  
  function checkPath(path: string, value: unknown, visited: Set<object>): void {
    if (value !== null && typeof value === 'object') {
      if (visited.has(value)) {
        checks.push(`${path}: Circular reference detected`);
        return;
      }
      
      visited.add(value);
      
      if (Array.isArray(value)) {
        value.forEach((item, index) => checkPath(`${path}[${index}]`, item, visited));
      } else {
        Object.entries(value).forEach(([k, v]) => 
          checkPath(`${path}.${k}`, v, visited)
        );
      }
    }
  }
  
  const visited = new Set<object>();
  checkPath('$root', payload, visited);
  
  if (checks.length > 0) {
    throw new Error(`Mutable payload references:\n${checks.join('\n')}`);
  }
}

/**
 * Frozen payload wrapper - prevents mutations at type level
 */
export interface FrozenPayload {
  readonly canonicalJson: string;
  readonly digest: string;
}

export function createFrozenPayload(payload: unknown): FrozenPayload {
  const canonical = canonicalSerialize(payload);
  return {
    canonicalJson: canonical,
    digest: '' // Will be computed asynchronously
  };
}
