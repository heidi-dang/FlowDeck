import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HostToolDefinition, JsonSchemaProperty } from "../../host-contracts/tool-definition"

function convertPropertyToSchema(prop: JsonSchemaProperty, s: typeof tool.schema): any {
  if (prop.type === "string") {
    let base = s.string()
    if (prop.description) base = base.describe(prop.description)
    return base
  }
  if (prop.type === "number") {
    let base = s.number()
    if (prop.description) base = base.describe(prop.description)
    return base
  }
  if (prop.type === "boolean") {
    let base = s.boolean()
    if (prop.description) base = base.describe(prop.description)
    return base
  }
  if (prop.type === "array") {
    let base = s.array(convertPropertyToSchema(prop.items, s))
    if (prop.description) base = base.describe(prop.description)
    return base
  }
  if (prop.type === "object" && prop.properties) {
    const shape: Record<string, any> = {}
    for (const [key, val] of Object.entries(prop.properties)) {
      shape[key] = convertPropertyToSchema(val, s)
    }
    let base = s.object(shape)
    if (prop.description) base = base.describe(prop.description)
    return base
  }
  return s.string()
}

/**
 * Converts a host-neutral HostToolDefinition into an OpenCode-native ToolDefinition.
 */
export function toOpenCodeTool<TArgs extends Record<string, unknown>, TResult>(
  def: HostToolDefinition<TArgs, TResult>
): ToolDefinition {
  const argsSchema: Record<string, any> = {}
  for (const [key, prop] of Object.entries(def.parameters.properties)) {
    const converted = convertPropertyToSchema(prop, tool.schema)
    const isRequired = def.parameters.required?.includes(key)
    argsSchema[key] = isRequired ? converted : converted.optional()
  }

  return tool({
    description: def.description,
    args: argsSchema,
    async execute(args, context) {
      const ctx = {
        sessionId: context?.sessionID ?? "unknown",
        directory: context?.directory ?? process.cwd(),
      }
      return def.execute(args as TArgs, ctx)
    },
  })
}
