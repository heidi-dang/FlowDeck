/**
 * Error fingerprinting for context reuse detection.
 * @module orchestration/context/error-fingerprint
 */

import { hashContent } from "./content-hasher";

export interface ErrorFingerprint {
  readonly hash: string;
  readonly errorType: string;
  readonly message: string;
  readonly stackPattern: string;
  readonly createdAt: Date;
}

export interface ErrorFingerprintData {
  readonly errorType: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Creates a fingerprint from an error for deduplication.
 */
export function createErrorFingerprint(data: ErrorFingerprintData): ErrorFingerprint {
  const stackPattern = extractStackPattern(data.stack ?? "");
  const hash = hashContent(`${data.errorType}|${data.message}|${stackPattern}`);

  return Object.freeze({
    hash,
    errorType: data.errorType,
    message: data.message,
    stackPattern,
    createdAt: new Date(),
  });
}

/**
 * Extracts a stable pattern from a stack trace (file + line number only).
 */
function extractStackPattern(stack: string): string {
  const lines = stack.split("\n").slice(1, 5);
  const pattern = lines
    .map((line) => {
      const match = line.match(/at\s+.+\s+\((.+):(\d+):\d+\)/);
      return match ? `${match[1]}:${match[2]}` : "";
    })
    .filter(Boolean)
    .join("|");

  return pattern || "no-stack";
}

/**
 * Returns true if two error fingerprints likely indicate the same error.
 */
export function isSameError(a: ErrorFingerprint, b: ErrorFingerprint): boolean {
  return a.hash === b.hash || (a.errorType === b.errorType && a.stackPattern === b.stackPattern);
}

/**
 * Creates a fingerprint from a native Error object.
 */
export function fingerprintError(error: Error): ErrorFingerprint {
  return createErrorFingerprint({
    errorType: error.constructor.name,
    message: error.message,
    stack: error.stack,
  });
}
