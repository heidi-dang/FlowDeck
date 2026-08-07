/**
 * Main trace replay engine.
 * @module orchestration/runtime/trace-replay
 */

import {
  TraceEvent,
  ReplayResult,
  ReplayState,
  ModelAdapter,
  ToolAdapter,
  ReplayClock,
} from "./trace-schema.js";
import { validateTrace } from "./trace-validator.js";

/**
 * Error thrown when trace validation fails.
 */
export class TraceValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: Array<{ eventId: string; field: string; message: string }>
  ) {
    super(message);
    this.name = "TraceValidationError";
  }
}

/**
 * Replay options.
 */
export interface ReplayOptions {
  strictValidation?: boolean;
}

/**
 * Replays a trace using the provided adapters.
 *
 * This function replays model and tool events from a recorded trace
 * without making actual external calls. Model and tool responses
 * come from the recorded trace data.
 */
export async function replayTrace(
  events: TraceEvent[],
  model: ModelAdapter,
  tools: ToolAdapter,
  clock: ReplayClock,
  options: ReplayOptions = {}
): Promise<ReplayResult> {
  const { strictValidation = true } = options;

  // Validate trace before replay
  if (strictValidation) {
    const validation = validateTrace(events);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => `${e.eventId}: ${e.message}`);
      throw new TraceValidationError(
        `Trace validation failed: ${errorMessages.join("; ")}`,
        validation.errors
      );
    }
  }

  const replayedEvents: TraceEvent[] = [];
  let errorCount = 0;
  const state: ReplayState = {};

  for (const event of events) {
    // Set clock to event timestamp for deterministic replay
    clock.setDate(new Date(event.timestamp));

    // Create replayed event with new id
    const replayedEvent: TraceEvent = { ...event, id: `${event.id}-replay` };

    try {
      switch (event.type) {
        case "tool_called":
          if (event.toolName && event.toolArgs) {
            const result = await tools.executeTool(event.toolName, event.toolArgs);
            replayedEvent.toolResult = result;
            state[`tool_${event.toolName}`] = result;
          }
          break;

        case "tool_error":
          errorCount++;
          state.lastError = event.error;
          break;

        case "specialist_failed":
          errorCount++;
          state.lastError = event.error;
          break;

        case "task_completed":
          state.finalStatus = (event.payload as { status: string }).status as ReplayState["finalStatus"];
          break;

        case "model_request":
          // Replay model request using adapter
          const modelPayload = event.payload as { prompt: unknown };
          const response = await model.complete(modelPayload.prompt);
          replayedEvent.toolResult = response;
          state.lastModelResponse = response;
          break;

        default:
          // No special handling needed for other event types
          break;
      }
    } catch (err) {
      replayedEvent.error = err instanceof Error ? err.message : String(err);
      errorCount++;
    }

    replayedEvents.push(replayedEvent);
  }

  return {
    events: replayedEvents,
    finalState: state,
    errorCount,
  };
}
