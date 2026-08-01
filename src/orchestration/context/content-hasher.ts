/**
 * SHA-256 content hashing for deduplication.
 */

/**
 * Computes SHA-256 hash of a string.
 */
export function hashContent(content: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(content);
  return h.digest("hex");
}

/**
 * Computes SHA-256 hash of file content.
 */
export function hashFileContent(content: string): string {
  return hashContent(content);
}

/**
 * Computes SHA-256 hash of symbol content (function, class, etc).
 */
export function hashSymbolContent(symbolName: string, symbolType: string, content: string): string {
  const payload = `${symbolType}:${symbolName}:${content}`;
  return hashContent(payload);
}

/**
 * Computes SHA-256 hash of a JSON-serializable object.
 */
export function hashObject(obj: unknown): string {
  const serialized = JSON.stringify(obj);
  return hashContent(serialized);
}
