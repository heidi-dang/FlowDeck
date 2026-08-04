/**
 * Canonical source-commit-SHA validator shared by the build, verify, and
 * runtime trust paths (P2-3).
 *
 * Lives in `src/tools` (not `scripts`) so the runtime bundle can import it
 * without violating the build's rootDir, while still being plain ESM that the
 * Node-only build/verify scripts can import natively.
 */

/** Returns an error message when the SHA is invalid, or null when valid. */
export function sourceCommitShaError(sha) {
  if (typeof sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(sha)) {
    return `source commit SHA ${JSON.stringify(sha)} is missing or not exactly 40 hexadecimal characters`
  }
  if (/^0+$/.test(sha)) {
    return `source commit SHA is all-zero (${sha}) — fabricated provenance`
  }
  return null
}

export function isValidSourceCommitSha(sha) {
  return sourceCommitShaError(sha) === null
}
