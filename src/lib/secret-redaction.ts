/**
 * Secret Redaction Utility
 *
 * Replaces known secret patterns with typed placeholders.
 * Used whenever session reports, logs, or diagnostic output
 * might contain credentials.
 *
 * Redacted patterns:
 * - npm tokens (npm_...)
 * - GitHub tokens (ghp_, gho_, ghu_, ghs_, ghf_)
 * - Bearer tokens in Authorization headers
 * - API keys (common patterns)
 * - _authToken values in any format
 * - Provider credentials
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // npm tokens: npm_<hex>
  [/npm_[a-zA-Z0-9]{36,}/g, "[REDACTED_NPM_TOKEN]"],
  // GitHub tokens
  [/gh[psuf]_[a-zA-Z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
  // Bearer tokens
  [/(Bearer\s+)[a-zA-Z0-9._\-+/=]{20,}/g, "$1[REDACTED_BEARER_TOKEN]"],
  // Authorization headers (full value)
  [/(authorization:\s*)(?:bearer\s+)?[a-zA-Z0-9._\-+/=]{20,}/gi, "$1[REDACTED_AUTHORIZATION]"],
  // _authToken
  [/"_authToken"\s*:\s*"[^"]+"/g, '"_authToken": "[REDACTED_AUTH_TOKEN]"'],
  // API keys (common env var values in logs)
  [/((?:API[_-]?KEY|api_key|apikey)\s*[:=]\s*['"]?)[a-zA-Z0-9_\-./+]{16,}['"]?/gi, "$1[REDACTED_API_KEY]"],
  // OpenAI-style sk- keys (sk-live / sk-test / sk-proj …)
  [/\bsk-[A-Za-z0-9_-]{4,}/g, "[REDACTED_API_KEY]"],
  // AWS-style access keys
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  // Provider credentials (anthropic, openai, vertex)
  [/((?:ANTHROPIC_API_KEY|OPENAI_API_KEY|VERTEX_API_KEY)\s*[:=]\s*['"]?)\S+['"]?/g, "$1[REDACTED_PROVIDER_KEY]"],
]

export const SECRET_KEY_PATTERNS = /api[_-]?key|token|secret|password|credential|auth/i

/**
 * Redact known secrets from a string.
 * Replaces each match with the corresponding typed placeholder.
 */
export function redactSecrets(input: string): string {
  if (!input || typeof input !== "string") return input
  let output = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}

/**
 * Check whether a string contains any known secret pattern.
 */
export function containsSecrets(input: string): boolean {
  if (!input || typeof input !== "string") return false
  for (const [pattern] of SECRET_PATTERNS) {
    // Create a fresh copy to avoid regex state carryover from the g flag
    const fresh = new RegExp(pattern.source, pattern.flags)
    if (fresh.test(input)) return true
  }
  return false
}

/**
 * Recursively redact secrets from arbitrary structured objects, arrays, or primitive values.
 * Handles circular object graphs, deep nesting, Error objects with cause chains,
 * and throwing getters without modifying the source objects.
 */
export function redactObjectSecrets<T>(
  val: T,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  maxDepth = 50
): T {
  if (depth > maxDepth) {
    return "[MAX_DEPTH]" as unknown as T
  }

  if (typeof val === "string") {
    return redactSecrets(val) as unknown as T
  }

  if (val === null || val === undefined || typeof val !== "object") {
    return val
  }

  if (seen.has(val as object)) {
    return "[CIRCULAR]" as unknown as T
  }
  seen.add(val as object)

  if (Array.isArray(val)) {
    return val.map((item) => redactObjectSecrets(item, seen, depth + 1, maxDepth)) as unknown as T
  }

  if (val instanceof Error) {
    const errorCopy: Record<string, unknown> = {
      name: val.name,
      message: redactSecrets(val.message),
      stack: val.stack ? redactSecrets(val.stack) : undefined,
    }
    if ((val as any).cause) {
      errorCopy.cause = redactObjectSecrets((val as any).cause, seen, depth + 1, maxDepth)
    }
    return errorCopy as unknown as T
  }

  const result: Record<string, unknown> = {}
  try {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0 && v.length < 500 && SECRET_KEY_PATTERNS.test(k)) {
        result[k] = "[REDACTED]"
      } else {
        result[k] = redactObjectSecrets(v, seen, depth + 1, maxDepth)
      }
    }
  } catch {
    return "[UNSERIALIZABLE]" as unknown as T
  }

  return result as unknown as T
}
