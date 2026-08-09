export type JsonSchema = Record<string, unknown>

export type ToolSchemaDeclaration = {
  toolId: string
  functionName?: string
  source?: string
  parameters: JsonSchema
}

export type ProviderCapabilities = {
  toolSchemaDialect: "standard" | "gemini"
}

export type GeminiSchemaDiagnostic = {
  toolId: string
  functionName: string
  source: string
  declarationIndex?: number
  path: string
  reason: string
  schemaFragment?: JsonSchema
}

export class GeminiToolSchemaError extends Error {
  readonly diagnostic: GeminiSchemaDiagnostic

  constructor(diagnostic: GeminiSchemaDiagnostic) {
    super(
      `Gemini tool schema rejected before request: toolId=${diagnostic.toolId} ` +
      `function=${diagnostic.functionName} source=${diagnostic.source} ` +
      `path=${diagnostic.path} reason=${diagnostic.reason}`,
    )
    this.name = "GeminiToolSchemaError"
    this.diagnostic = diagnostic
  }
}

const ARRAY_ONLY_KEYS = new Set(["items", "minItems", "maxItems", "uniqueItems"])
const UNSUPPORTED_GEMINI_KEYS = new Set(["$schema", "$comment", "unevaluatedProperties", "dependentSchemas", "if", "then", "else"])

function isObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function schemaType(schema: JsonSchema): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined
}

function fail(meta: ToolSchemaDeclaration, path: string, reason: string, fragment: JsonSchema, declarationIndex?: number): never {
  throw new GeminiToolSchemaError({
    toolId: meta.toolId,
    functionName: meta.functionName ?? meta.toolId,
    source: meta.source ?? "unknown",
    declarationIndex,
    path,
    reason,
    schemaFragment: fragment,
  })
}

function normalizeNode(
  meta: ToolSchemaDeclaration,
  value: unknown,
  path: string,
  declarationIndex?: number,
): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => normalizeNode(meta, entry, `${path}[${index}]`, declarationIndex))
  if (!isObject(value)) return value

  const type = schemaType(value)
  if (type !== "array" && ARRAY_ONLY_KEYS.has("items") && "items" in value) {
    fail(meta, path, "non-array schema contains array-only items", value, declarationIndex)
  }
  if (type === "array" && !("items" in value)) {
    fail(meta, `${path}.items`, "array schema is missing items", value, declarationIndex)
  }
  if (type && type !== "object" && "properties" in value) {
    fail(meta, `${path}.properties`, "non-object schema contains properties", value, declarationIndex)
  }

  const result: JsonSchema = {}
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_GEMINI_KEYS.has(key)) continue
    if (key === "properties" && isObject(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, property]) => [
        name,
        normalizeNode(meta, property, `${path}.properties.${name}`, declarationIndex),
      ]))
      continue
    }
    if (key === "required" && Array.isArray(child)) {
      result[key] = child.filter((item): item is string => typeof item === "string")
      continue
    }
    result[key] = normalizeNode(meta, child, `${path}.${key}`, declarationIndex)
  }

  // JSON Schema producers sometimes omit `type: object` when they emit
  // properties. Gemini requires an explicit object representation; adding it
  // here is semantics-preserving and remains provider-local.
  if (!type && "properties" in result) result.type = "object"

  if (type === "array" && !isObject(result.items)) {
    fail(meta, `${path}.items`, "array items must be a schema object", result, declarationIndex)
  }
  if (type === "object" && "properties" in result && !isObject(result.properties)) {
    fail(meta, `${path}.properties`, "object properties must be a schema object", result, declarationIndex)
  }
  return result
}

export function providerCapabilities(providerId: string | undefined): ProviderCapabilities {
  const id = (providerId ?? "").toLowerCase()
  return /(^|[-_])(gemini|google|antigravity)([-_]|$)/.test(id)
    ? { toolSchemaDialect: "gemini" }
    : { toolSchemaDialect: "standard" }
}

export function normalizeToolSchemaForGemini(
  declaration: ToolSchemaDeclaration,
  declarationIndex?: number,
): JsonSchema {
  const normalized = normalizeNode(declaration, declaration.parameters, "parameters", declarationIndex)
  if (!isObject(normalized)) fail(declaration, "parameters", "parameters must be an object schema", { value: normalized }, declarationIndex)
  if (schemaType(normalized) !== "object") {
    fail(declaration, "parameters.type", "parameters must use an explicit object representation", normalized, declarationIndex)
  }
  return normalized
}

export function validateGeminiToolSchema(
  declaration: ToolSchemaDeclaration,
  declarationIndex?: number,
): void {
  normalizeToolSchemaForGemini(declaration, declarationIndex)
}

export function normalizeToolsForProvider(
  capabilities: ProviderCapabilities,
  declarations: readonly ToolSchemaDeclaration[],
): ToolSchemaDeclaration[] {
  if (capabilities.toolSchemaDialect !== "gemini") return declarations.map((declaration) => ({ ...declaration, parameters: structuredClone(declaration.parameters) }))
  return declarations.map((declaration, index) => ({
    ...declaration,
    parameters: normalizeToolSchemaForGemini(declaration, index),
  }))
}

export function formatGeminiSchemaDiagnostic(error: unknown): string {
  if (error instanceof GeminiToolSchemaError) return error.message
  return `Gemini tool schema compatibility failure: ${error instanceof Error ? error.message : String(error)}`
}
