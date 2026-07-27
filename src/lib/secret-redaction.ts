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
  [/(?:API[_-]?KEY|api_key|apikey)\s*[:=]\s*['"]?[a-zA-Z0-9_\-./+]{16,}/gi, "$1: [REDACTED_API_KEY]"],
  // Provider credentials (anthropic, openai, vertex)
  [/(ANTHROPIC_API_KEY|OPENAI_API_KEY|VERTEX_API_KEY)\s*=\s*\S+/g, "$1=[REDACTED_PROVIDER_KEY]"],
]

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
