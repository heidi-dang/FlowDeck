/**
 * Schema validation for trace events.
 * @module orchestration/runtime/trace-replay
 */

import {
  TraceEvent,
  TraceEventType,
  TRACE_SCHEMA_VERSION,
  MIN_SUPPORTED_VERSION,
  MAX_SUPPORTED_VERSION,
} from "./trace-schema.js";

/**
 * Known event types in current schema version.
 */
const KNOWN_EVENT_TYPES: readonly TraceEventType[] = [
  "task_started",
  "task_completed",
  "specialist_invoked",
  "specialist_completed",
  "specialist_failed",
  "tool_called",
  "tool_result",
  "tool_error",
  "verification_started",
  "verification_completed",
  "cancellation_requested",
  "model_request",
  "model_response",
] as const;

/**
 * Required fields per event type.
 */
const REQUIRED_FIELDS: Record<TraceEventType, string[]> = {
  task_started: ["id", "type", "timestamp", "payload"],
  task_completed: ["id", "type", "timestamp", "payload"],
  specialist_invoked: ["id", "type", "timestamp", "payload", "agentId"],
  specialist_completed: ["id", "type", "timestamp", "payload", "agentId"],
  specialist_failed: ["id", "type", "timestamp", "payload", "agentId", "error"],
  tool_called: ["id", "type", "timestamp", "payload", "toolName", "toolArgs"],
  tool_result: ["id", "type", "timestamp", "payload", "toolName", "toolResult"],
  tool_error: ["id", "type", "timestamp", "payload", "toolName", "error"],
  verification_started: ["id", "type", "timestamp", "payload"],
  verification_completed: ["id", "type", "timestamp", "payload"],
  cancellation_requested: ["id", "type", "timestamp", "payload"],
  model_request: ["id", "type", "timestamp", "payload"],
  model_response: ["id", "type", "timestamp", "payload"],
};

export interface ValidationError {
  eventId: string;
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

/**
 * Validates that an event has all required fields for its type.
 */
export function validateEventStructure(event: TraceEvent): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!event.id || typeof event.id !== "string") {
    errors.push({ eventId: event.id ?? "unknown", field: "id", message: "Event must have a string id" });
  }

  if (!event.type || typeof event.type !== "string") {
    errors.push({ eventId: event.id ?? "unknown", field: "type", message: "Event must have a string type" });
  }

  if (typeof event.timestamp !== "number" || event.timestamp <= 0) {
    errors.push({ eventId: event.id ?? "unknown", field: "timestamp", message: "Event must have a positive numeric timestamp" });
  }

  if (!event.payload || typeof event.payload !== "object") {
    errors.push({ eventId: event.id ?? "unknown", field: "payload", message: "Event must have an object payload" });
  }

  return errors;
}

/**
 * Validates that an event type is known in the schema version.
 */
export function validateEventVersion(event: TraceEvent): ValidationError[] {
  const errors: ValidationError[] = [];
  const version = event.version ?? TRACE_SCHEMA_VERSION;

  if (version < MIN_SUPPORTED_VERSION || version > MAX_SUPPORTED_VERSION) {
    errors.push({
      eventId: event.id,
      field: "version",
      message: `Unsupported schema version ${version}. Supported range: ${MIN_SUPPORTED_VERSION}-${MAX_SUPPORTED_VERSION}`,
    });
  }

  if (!(KNOWN_EVENT_TYPES as readonly string[]).includes(event.type)) {
    errors.push({
      eventId: event.id,
      field: "type",
      message: `Unknown event type "${event.type}". Known types: ${KNOWN_EVENT_TYPES.join(", ")}`,
    });
  }

  return errors;
}

/**
 * Validates that an event has all required fields for its type.
 */
export function validateRequiredFields(event: TraceEvent): ValidationError[] {
  const errors: ValidationError[] = [];
  const required = REQUIRED_FIELDS[event.type] ?? [];

  for (const field of required) {
    if (!(field in event) || event[field as keyof TraceEvent] === undefined) {
      errors.push({
        eventId: event.id,
        field,
        message: `Event type "${event.type}" requires field "${field}"`,
      });
    }
  }

  return errors;
}

/**
 * Validates a complete trace for replay readiness.
 */
export function validateTrace(trace: TraceEvent[]): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  if (trace.length === 0) {
    errors.push({
      eventId: "trace",
      field: "events",
      message: "Trace is empty - cannot replay an incomplete trace",
    });
    return { valid: false, errors, warnings };
  }

  // Check for start event
  const hasStart = trace.some((e) => e.type === "task_started");
  if (!hasStart) {
    errors.push({
      eventId: "trace",
      field: "events",
      message: "Trace is incomplete - missing task_started event",
    });
  }

  // Check for terminal event
  const hasTerminal = trace.some((e) =>
    e.type === "task_completed" || e.type === "specialist_failed"
  );
  if (!hasTerminal) {
    errors.push({
      eventId: "trace",
      field: "events",
      message: "Trace is incomplete - missing terminal event (task_completed or specialist_failed)",
    });
  }

  // Validate each event
  for (const event of trace) {
    errors.push(...validateEventStructure(event));
    errors.push(...validateEventVersion(event));
    errors.push(...validateRequiredFields(event));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
