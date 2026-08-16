/**
 * HostToolDefinition — portable tool shape FlowDeck produces.
 *
 * FlowDeck's tools (FDX, Heidi controls, governance) need to be registered
 * into the host's tool registry. Each host has its own registration API
 * (OpenCode's `tool()` helper, DSH's `ctx.tools.register()`).
 *
 * This type captures exactly what FlowDeck provides; the host adapter
 * translates it to the host-specific registration format.
 *
 * We do NOT replicate the full host tool API — only the fields FlowDeck's
 * tools actually populate.
 */

/** JSON Schema type for tool parameter declarations. */
export type JsonSchemaProperty =
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: JsonSchemaProperty; description?: string }
  | { type: 'object'; properties?: Record<string, JsonSchemaProperty>; required?: string[]; description?: string }

/** Execution context passed to tool handlers by the host adapter. */
export interface ToolExecuteContext {
  /** Session that invoked this tool. */
  readonly sessionId: string
  /** Working directory at the time of invocation. */
  readonly directory: string
  /** The agent/role that invoked this tool. */
  readonly agent?: string | undefined
}

/**
 * Portable tool definition produced by FlowDeck.
 * Host adapters translate this to their native registration format.
 */
export interface HostToolDefinition<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> {
  /** Tool identifier — must be unique within the host's tool registry. */
  readonly name: string

  /** One-sentence description shown to the model. */
  readonly description: string

  /**
   * JSON Schema for the tool's input parameters.
   * The host validates arguments against this before calling execute().
   */
  readonly parameters: {
    type: 'object'
    properties: Record<string, JsonSchemaProperty>
    required?: string[]
  }

  /**
   * Execute the tool.
   * Receives typed arguments and execution context.
   * Returns a result the host serializes into the model's context.
   */
  execute(args: TArgs, ctx: ToolExecuteContext): Promise<TResult>
}
