/**
 * Versioned trace schema types for trace replay.
 * @module orchestration/runtime/trace-replay
 */

export const TRACE_SCHEMA_VERSION = 1;
export const MIN_SUPPORTED_VERSION = 1;
export const MAX_SUPPORTED_VERSION = 1;

/**
 * Core trace event structure.
 * All events have a consistent shape with type-specific payload discrimination.
 */
export interface TraceEvent {
  id: string;
  type: TraceEventType;
  timestamp: number;
  payload: TracePayload;
  agentId?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  error?: string;
  version?: number;
}

/**
 * Discriminated union of all possible trace event types.
 */
export type TraceEventType =
  | "task_started"
  | "task_completed"
  | "specialist_invoked"
  | "specialist_completed"
  | "specialist_failed"
  | "tool_called"
  | "tool_result"
  | "tool_error"
  | "verification_started"
  | "verification_completed"
  | "cancellation_requested"
  | "model_request"
  | "model_response";

/**
 * Type-specific payload for each event type.
 */
export type TracePayload =
  | TaskStartedPayload
  | TaskCompletedPayload
  | SpecialistInvokedPayload
  | SpecialistCompletedPayload
  | SpecialistFailedPayload
  | ToolCalledPayload
  | ToolResultPayload
  | ToolErrorPayload
  | VerificationStartedPayload
  | VerificationCompletedPayload
  | CancellationRequestedPayload
  | ModelRequestPayload
  | ModelResponsePayload
  | UnknownPayload;

export interface TaskStartedPayload {
  scenarioId: string;
  gitSha: string;
}

export interface TaskCompletedPayload {
  status: "success" | "failure" | "cancelled";
  error?: string;
}

export interface SpecialistInvokedPayload {
  specialist: string;
  task: string;
}

export interface SpecialistCompletedPayload {
  specialist: string;
  result: unknown;
}

export interface SpecialistFailedPayload {
  specialist: string;
  error: string;
}

export interface ToolCalledPayload {
  tool: string;
  args: unknown;
}

export interface ToolResultPayload {
  tool: string;
  result: unknown;
}

export interface ToolErrorPayload {
  tool: string;
  error: string;
}

export interface VerificationStartedPayload {
  /* empty */
}

export interface VerificationCompletedPayload {
  verified: boolean;
  details?: string;
}

export interface CancellationRequestedPayload {
  reason?: string;
}

export interface ModelRequestPayload {
  model: string;
  prompt: unknown;
}

export interface ModelResponsePayload {
  model: string;
  response: unknown;
}

export interface UnknownPayload {
  [key: string]: unknown;
}

/**
 * Result of replaying a trace.
 */
export interface ReplayResult {
  events: TraceEvent[];
  finalState: ReplayState;
  errorCount: number;
}

/**
 * State reconstructed during replay.
 */
export interface ReplayState {
  finalStatus?: "success" | "failure" | "cancelled";
  lastError?: string;
  [key: string]: unknown;
}

/**
 * Adapter interface for model providers during replay.
 * No actual LLM calls are made - responses come from recorded trace data.
 */
export interface ModelAdapter {
  complete(input: unknown): Promise<unknown>;
}

/**
 * Adapter interface for tool execution during replay.
 * No actual tools are invoked - results come from recorded trace data.
 */
export interface ToolAdapter {
  executeTool(name: string, args: unknown): Promise<unknown>;
}

/**
 * Clock interface for controlling time during replay.
 */
export interface ReplayClock {
  setDate(date: Date): void;
  now(): number;
}
