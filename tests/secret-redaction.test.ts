/**
 * Secret Redaction Tests
 *
 * Verifies deterministic, repeatable secret detection and redaction.
 * All test tokens are synthetic and not real credentials.
 */

import { describe, it, expect } from "bun:test"
import { redactSecrets, containsSecrets, redactObjectSecrets } from "../src/lib/secret-redaction"

describe("redactSecrets", () => {
  it("redacts npm tokens", () => {
    const input = "token=npm_abcdefghijklmnopqrstuvwxyzabcdefghij"
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_NPM_TOKEN]")
    expect(result).not.toContain("npm_abcdefghijklmnopqrstuvwxyzabcdefghij")
  })

  it("redacts GitHub tokens", () => {
    expect(redactSecrets("ghp_123456789012345678901234567890123456")).toContain("[REDACTED_GITHUB_TOKEN]")
    expect(redactSecrets("ghs_123456789012345678901234567890123456")).toContain("[REDACTED_GITHUB_TOKEN]")
    expect(redactSecrets("ghu_123456789012345678901234567890123456")).toContain("[REDACTED_GITHUB_TOKEN]")
    expect(redactSecrets("ghf_123456789012345678901234567890123456")).toContain("[REDACTED_GITHUB_TOKEN]")
  })

  it("redacts bearer tokens", () => {
    const input = "Authorization: Bearer syntheticbearertoken12345678901234567890"
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_BEARER_TOKEN]")
  })

  it("redacts authorization headers", () => {
    const input = "authorization: synthetictoken12345678901234567890"
    const result = redactSecrets(input)
    expect(result).toContain("[REDACTED_AUTHORIZATION]")
  })

  it("redacts _authToken", () => {
    const input = '{"_authToken": "abcdef-1234-5678-9012"}'
    expect(redactSecrets(input)).toContain('"_authToken": "[REDACTED_AUTH_TOKEN]"')
  })

  it("redacts API keys and OpenAI/AWS/Provider keys", () => {
    expect(redactSecrets("api_key = 'abcdef0123456789abcdef0123456789'")).toContain("[REDACTED_API_KEY]")
    expect(redactSecrets("sk-1234567890abcdef")).toContain("[REDACTED_API_KEY]")
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]")
    expect(redactSecrets("OPENAI_API_KEY='secretkeyval'")).toContain("[REDACTED_PROVIDER_KEY]")
    expect(redactSecrets("ANTHROPIC_API_KEY='secretkeyval'")).toContain("[REDACTED_PROVIDER_KEY]")
    expect(redactSecrets("VERTEX_API_KEY='secretkeyval'")).toContain("[REDACTED_PROVIDER_KEY]")
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

describe("redactObjectSecrets", () => {
  it("handles primitives", () => {
    expect(redactObjectSecrets("sk-test12345")).toBe("[REDACTED_API_KEY]")
    expect(redactObjectSecrets(123)).toBe(123)
    expect(redactObjectSecrets(true)).toBe(true)
    expect(redactObjectSecrets(null)).toBeNull()
    expect(redactObjectSecrets(undefined)).toBeUndefined()
  })

  it("handles arrays and nested objects with secret property names", () => {
    const data = {
      apiKey: "sensitive-value-here",
      token: "secret-token",
      password: "pass",
      credential: "cred",
      auth: "auth-val",
      plain: "normal",
      nested: {
        items: ["normal", "sk-1234567890"],
      },
    }
    const res: any = redactObjectSecrets(data)
    expect(res.apiKey).toBe("[REDACTED]")
    expect(res.token).toBe("[REDACTED]")
    expect(res.password).toBe("[REDACTED]")
    expect(res.credential).toBe("[REDACTED]")
    expect(res.auth).toBe("[REDACTED]")
    expect(res.plain).toBe("normal")
    expect(res.nested.items[0]).toBe("normal")
    expect(res.nested.items[1]).toBe("[REDACTED_API_KEY]")
  })

  it("handles circular references and recursion limits", () => {
    const obj: any = { a: 1 }
    obj.self = obj
    const res: any = redactObjectSecrets(obj)
    expect(res.self).toBe("[CIRCULAR]")

    const arr: any[] = [1]
    arr.push(arr)
    const arrRes: any = redactObjectSecrets(arr)
    expect(arrRes[1]).toBe("[CIRCULAR]")

    let deep: any = { val: 1 }
    for (let i = 0; i < 55; i++) {
      deep = { next: deep }
    }
    const deepRes: any = redactObjectSecrets(deep)
    expect(JSON.stringify(deepRes)).toContain("[MAX_DEPTH]")
  })

  it("handles Error objects and cause chains", () => {
    const err = new Error("Failed with sk-1234567890", {
      cause: new Error("Underlying auth failed with token=npm_abcdefghijklmnopqrstuvwxyzabcdefghij"),
    })
    const res: any = redactObjectSecrets(err)
    expect(res.name).toBe("Error")
    expect(res.message).toContain("[REDACTED_API_KEY]")
    expect(res.cause.message).toContain("[REDACTED_NPM_TOKEN]")
  })

  it("handles throwing property getters gracefully", () => {
    const throwingObj = {}
    Object.defineProperty(throwingObj, "unreadable", {
      get() {
        throw new Error("Getter boom")
      },
      enumerable: true,
    })
    const res = redactObjectSecrets(throwingObj)
    expect(res).toBe("[UNSERIALIZABLE]")
  })
})
