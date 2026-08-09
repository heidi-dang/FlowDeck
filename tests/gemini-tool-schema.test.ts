import { describe, expect, it } from "bun:test"
import {
  GeminiToolSchemaError,
  normalizeToolSchemaForGemini,
  normalizeToolsForProvider,
  providerCapabilities,
  validateGeminiToolSchema,
} from "../src/services/gemini-tool-schema"

const declaration = (parameters: Record<string, unknown>, source = "test") => ({
  toolId: "schema-test",
  functionName: "schema_test",
  source,
  parameters,
})

describe("Gemini tool schema compatibility", () => {
  it("rejects the malformed query.level array with an actionable path", () => {
    expect(() => validateGeminiToolSchema(declaration({
      type: "object",
      properties: { query: { type: "object", properties: { level: { anyOf: [{ type: "string" }, { type: "array" }] } } } },
    }), 101)).toThrow("parameters.properties.query.properties.level.anyOf[1].items")
  })

  it("rejects the malformed files array with an actionable path", () => {
    expect(() => validateGeminiToolSchema(declaration({
      type: "object",
      properties: { files: { anyOf: [{ type: "string" }, { type: "array" }] } },
    }), 125)).toThrow("parameters.properties.files.anyOf[1].items")
  })

  it("preserves string|string[] semantics and validates every branch", () => {
    const result = normalizeToolSchemaForGemini(declaration({
      type: "object",
      properties: { files: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
    }))
    expect((result.properties as any).files.anyOf[1]).toEqual({ type: "array", items: { type: "string" } })
  })

  it("rejects scalar items instead of fabricating an array contract", () => {
    expect(() => validateGeminiToolSchema(declaration({ type: "object", properties: { level: { type: "string", items: { type: "string" } } } }))).toThrow(GeminiToolSchemaError)
  })

  it("handles nested nullable arrays, enums, maps, and arrays of objects", () => {
    const result = normalizeToolSchemaForGemini(declaration({
      type: "object",
      properties: {
        values: { anyOf: [{ type: "null" }, { type: "array", items: { type: "string", enum: ["a", "b"] } }] },
        records: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
    }))
    expect(result.type).toBe("object")
    expect((result.properties as any).records.items.type).toBe("object")
    expect((result.properties as any).values.anyOf[1].items.enum).toEqual(["a", "b"])
  })

  it("normalizes an omitted object type without weakening the contract", () => {
    const result = normalizeToolSchemaForGemini(declaration({ properties: { query: { properties: { level: { type: "string" } } } } }))
    expect(result.type).toBe("object")
    expect((result.properties as any).query.type).toBe("object")
  })

  it("rejects unsupported ambiguous dynamic schemas before transmission", () => {
    expect(() => validateGeminiToolSchema(declaration({ type: "object", properties: { values: { type: "array" } } }, "mcp"))).toThrow(/array schema is missing items/)
  })

  it("isolates Gemini normalization from standard providers", () => {
    const input = declaration({ type: "object", properties: { files: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } } }, "built-in")
    const standard = normalizeToolsForProvider(providerCapabilities("openai"), [input])[0]
    const gemini = normalizeToolsForProvider(providerCapabilities("google"), [input])[0]
    expect(standard.parameters).toEqual(input.parameters)
    expect(gemini.parameters).toEqual(input.parameters)
    expect(standard.parameters).not.toBe(input.parameters)
  })

  it.each(["built-in", "mcp", "openapi", "plugin", "subagent"])("validates dynamic source: %s", (source) => {
    expect(() => validateGeminiToolSchema(declaration({ type: "object", properties: { files: { type: "array", items: { type: "string" } } } }, source))).not.toThrow()
  })
})
