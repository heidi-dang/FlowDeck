import { describe, expect, it } from "bun:test"
import { classifyProviderFailure } from "../src/services/provider-error-classification"

describe("provider error classification", () => {
  it("fails closed for Gemini tool-schema HTTP 400s", () => {
    const result = classifyProviderFailure(400, "GenerateContentRequest.tools[0].function_declarations[1].parameters.properties.files.items")
    expect(result.category).toBe("schema_compatibility")
    expect(result.retryable).toBe(false)
    expect(result.rotateCredentials).toBe(false)
  })

  it.each([429, 500, 502, 503])("retains transient handling for HTTP %s", (status) => {
    expect(classifyProviderFailure(status, "temporary provider failure").retryable).toBe(true)
  })

  it("retains timeout and reset retry behavior", () => {
    expect(classifyProviderFailure(undefined, "connect ETIMEDOUT").retryable).toBe(true)
    expect(classifyProviderFailure(undefined, "connection reset by peer").retryable).toBe(true)
  })
})
