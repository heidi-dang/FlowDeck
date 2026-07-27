/**
 * Secret Redaction Tests
 *
 * Verifies deterministic, repeatable secret detection and redaction.
 * All test tokens are synthetic and not real credentials.
 */

import { describe, it, expect } from "vitest"
import { redactSecrets, containsSecrets } from "../src/lib/secret-redaction"

describe("redactSecrets", () => {
  it("redacts npm tokens", () => {
    const input = 'token=npm_abcdefghijklmnopqrstuvwxyzabcdefghij'
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_NPM_TOKEN]")
    expect(result).not.toContain("npm_synthetictoken")
  })

  it("redacts bearer tokens", () => {
    const input = 'Authorization: Bearer syntheticbearertoken12345678901234567890'
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_BEARER_TOKEN]")
  })

  it("redacts authorization headers", () => {
    const input = 'authorization: synthetictoken12345678901234567890'
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_AUTHORIZATION]")
  })

  it("leaves non-secret text unchanged", () => {
    const input = "Hello, this is a normal message without secrets."
    expect(redactSecrets(input)).toBe(input)
  })

  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("")
  })

  it("handles null/undefined", () => {
    expect(redactSecrets(null as any)).toBeNull()
    expect(redactSecrets(undefined as any)).toBeUndefined()
  })

  it("is deterministic across multiple calls", () => {
    const secret = "npm_abcdefghijklmnopqrstuvwxyzabcdefghij"
    const first = redactSecrets(secret)
    const second = redactSecrets(secret)
    const third = redactSecrets(secret)
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(first).toContain("[REDACTED_NPM_TOKEN]")
  })
})

describe("containsSecrets", () => {
  it("detects npm tokens on first call", () => {
    expect(containsSecrets("npm_abcdefghijklmnopqrstuvwxyzabcdefghij")).toBe(true)
  })

  it("detects npm tokens on repeated calls (no regex state carryover)", () => {
    const secret = "npm_abcdefghijklmnopqrstuvwxyzabcdefghij"
    expect(containsSecrets(secret)).toBe(true)
    expect(containsSecrets(secret)).toBe(true)
    expect(containsSecrets(secret)).toBe(true)
  })

  it("returns false for normal text", () => {
    expect(containsSecrets("Hello, world!")).toBe(false)
  })

  it("handles empty/undefined input", () => {
    expect(containsSecrets("")).toBe(false)
    expect(containsSecrets(null as any)).toBe(false)
  })
})
