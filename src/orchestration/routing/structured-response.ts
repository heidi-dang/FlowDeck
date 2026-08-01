/**
 * Structured response validation for critical routing and control decisions.
 *
 * Critical decisions must use validated structured output to ensure
 * reliability and traceability. Free-form prose must not be parsed
 * for runtime-critical state.
 */

export interface StructuredControlResponse {
  readonly type: "routing" | "control" | "state";
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly validation: {
    readonly schemaVersion: string;
    readonly validatedAt: Date;
  };
}

interface ValidationRule {
  readonly required: boolean;
  readonly type: "string" | "number" | "boolean" | "object" | "array" | "enum";
  readonly enumValues?: readonly string[];
}

const SCHEMA_VERSION = "1.0.0";

const TYPE_VALIDATION_RULES: Record<string, Record<string, ValidationRule>> = {
  routing: {
    type: { required: true, type: "enum", enumValues: ["routing"] },
    action: { required: true, type: "string" },
    parameters: { required: true, type: "object" },
    validation: { required: true, type: "object" },
  },
  control: {
    type: { required: true, type: "enum", enumValues: ["control"] },
    action: { required: true, type: "string" },
    parameters: { required: true, type: "object" },
    validation: { required: true, type: "object" },
  },
  state: {
    type: { required: true, type: "enum", enumValues: ["state"] },
    action: { required: true, type: "string" },
    parameters: { required: true, type: "object" },
    validation: { required: true, type: "object" },
  },
};

export class StructuredResponseValidator {
  private schemaVersion: string = SCHEMA_VERSION;

  validate(response: unknown): StructuredControlResponse {
    if (response === null || response === undefined) {
      throw new StructuredResponseValidationError("Response cannot be null or undefined");
    }

    if (typeof response !== "object") {
      throw new StructuredResponseValidationError(`Expected object, got ${typeof response}`);
    }

    const obj = response as Record<string, unknown>;

    // Validate type field
    if (typeof obj.type !== "string") {
      throw new StructuredResponseValidationError("Missing or invalid 'type' field");
    }

    const typeValue = obj.type as string;
    if (!["routing", "control", "state"].includes(typeValue)) {
      throw new StructuredResponseValidationError(`Invalid type value: ${typeValue}`);
    }

    // Validate against type-specific rules
    const rules = TYPE_VALIDATION_RULES[typeValue];
    this.validateFields(obj, rules, typeValue);

    // Validate nested validation object
    if (typeof obj.validation !== "object" || obj.validation === null) {
      throw new StructuredResponseValidationError("Missing or invalid 'validation' field");
    }

    const validation = obj.validation as Record<string, unknown>;
    if (typeof validation.schemaVersion !== "string") {
      throw new StructuredResponseValidationError("Missing or invalid 'validation.schemaVersion'");
    }
    if (!(validation.validatedAt instanceof Date) && typeof validation.validatedAt !== "string") {
      throw new StructuredResponseValidationError("Missing or invalid 'validation.validatedAt'");
    }

    // Validate parameters structure
    if (typeof obj.parameters !== "object" || obj.parameters === null) {
      throw new StructuredResponseValidationError("Missing or invalid 'parameters' field");
    }

    return {
      type: typeValue as StructuredControlResponse["type"],
      action: obj.action as string,
      parameters: obj.parameters as Record<string, unknown>,
      validation: {
        schemaVersion: validation.schemaVersion as string,
        validatedAt: validation.validatedAt instanceof Date ? validation.validatedAt : new Date(validation.validatedAt as string),
      },
    };
  }

  private validateFields(obj: Record<string, unknown>, rules: Record<string, ValidationRule>, context: string): void {
    for (const [field, rule] of Object.entries(rules)) {
      const value = obj[field];

      if (rule.required && (value === undefined || value === null)) {
        throw new StructuredResponseValidationError(`Missing required field '${field}' in ${context} response`);
      }

      if (value === undefined || value === null) {
        continue; // Optional field not provided
      }

      if (rule.type === "enum") {
        if (!rule.enumValues || !rule.enumValues.includes(value as string)) {
          throw new StructuredResponseValidationError(
            `Invalid value for '${field}' in ${context}: expected one of [${rule.enumValues?.join(", ")}], got ${value}`,
          );
        }
      } else if (rule.type === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new StructuredResponseValidationError(`Field '${field}' in ${context} must be an object`);
        }
      } else if (rule.type === "array") {
        if (!Array.isArray(value)) {
          throw new StructuredResponseValidationError(`Field '${field}' in ${context} must be an array`);
        }
      } else if (typeof value !== rule.type) {
        throw new StructuredResponseValidationError(
          `Field '${field}' in ${context} has wrong type: expected ${rule.type}, got ${typeof value}`,
        );
      }
    }
  }

  createRoutingResponse(action: string, parameters: Record<string, unknown>): StructuredControlResponse {
    return {
      type: "routing",
      action,
      parameters,
      validation: {
        schemaVersion: this.schemaVersion,
        validatedAt: new Date(),
      },
    };
  }

  createControlResponse(action: string, parameters: Record<string, unknown>): StructuredControlResponse {
    return {
      type: "control",
      action,
      parameters,
      validation: {
        schemaVersion: this.schemaVersion,
        validatedAt: new Date(),
      },
    };
  }

  createStateResponse(action: string, parameters: Record<string, unknown>): StructuredControlResponse {
    return {
      type: "state",
      action,
      parameters,
      validation: {
        schemaVersion: this.schemaVersion,
        validatedAt: new Date(),
      },
    };
  }
}

export class StructuredResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredResponseValidationError";
  }
}
