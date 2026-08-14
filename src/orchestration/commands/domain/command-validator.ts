import type { CommandDefinition } from "./command-definition";

export interface CommandValidationError {
  commandId: string;
  field: string;
  reason: string;
  expectedShape?: string;
}

export class CommandValidationException extends Error {
  constructor(public readonly errors: CommandValidationError[]) {
    super(`Command validation failed for '${errors[0]?.commandId ?? "unknown"}': ${errors.map((e) => `${e.field}: ${e.reason}`).join("; ")}`);
    this.name = "CommandValidationException";
  }
}

/**
 * Validate input payload against a CommandDefinition's input schema and custom validator.
 */
export function validateCommandInput(
  definition: CommandDefinition,
  input: unknown,
): { valid: boolean; errors: CommandValidationError[] } {
  const errors: CommandValidationError[] = [];
  const commandId = definition.id;

  if (input === null || typeof input !== "object") {
    return {
      valid: false,
      errors: [
        {
          commandId,
          field: "root",
          reason: "Input must be an object",
          expectedShape: "object",
        },
      ],
    };
  }

  const payload = input as Record<string, unknown>;
  const schema = definition.inputSchema;

  if (schema) {
    if (schema.required) {
      for (const requiredField of schema.required) {
        if (payload[requiredField] === undefined || payload[requiredField] === null || payload[requiredField] === "") {
          errors.push({
            commandId,
            field: requiredField,
            reason: `Required field '${requiredField}' is missing or empty`,
            expectedShape: schema.properties?.[requiredField]?.type ?? "string",
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, val] of Object.entries(payload)) {
        const propDef = schema.properties[key];
        if (propDef && val !== undefined && val !== null) {
          const actualType = typeof val;
          if (propDef.type === "string" && actualType !== "string") {
            errors.push({
              commandId,
              field: key,
              reason: `Field '${key}' expected type string, got ${actualType}`,
              expectedShape: "string",
            });
          } else if (propDef.type === "number" && actualType !== "number") {
            errors.push({
              commandId,
              field: key,
              reason: `Field '${key}' expected type number, got ${actualType}`,
              expectedShape: "number",
            });
          } else if (propDef.type === "boolean" && actualType !== "boolean") {
            errors.push({
              commandId,
              field: key,
              reason: `Field '${key}' expected type boolean, got ${actualType}`,
              expectedShape: "boolean",
            });
          }
        }
      }
    }
  }

  if (definition.validateInput) {
    const customResult = definition.validateInput(input);
    if (!customResult.valid && customResult.errors) {
      for (const err of customResult.errors) {
        errors.push({
          commandId,
          field: err.field,
          reason: err.reason,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
