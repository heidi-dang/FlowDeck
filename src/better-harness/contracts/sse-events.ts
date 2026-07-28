/**
 * Canonical FlowDeck SSE Event Contract.
 *
 * Every named SSE event uses the canonical wire envelope:
 *
 *   id: <decimal-sequence-id>
 *   event: <named-event-type>
 *   data: {"type":"<named-event-type>","timestamp":"<ISO-8601>","data":<event-specific-payload>}
 *
 * Contract version tracks schema changes. Bump when adding/removing/renaming
 * event types or changing payload shapes.
 */
import { z } from "zod/v4";

// ── Contract version ─────────────────────────────────────────────────────
export const SSE_CONTRACT_VERSION = "1.0.0";

// ── Supported event types ─────────────────────────────────────────────────
export const SSESupportedEventEnum = z.enum([
  "connected",
  "heartbeat",
  "run.queued",
  "run.started",
  "collector.started",
  "collector.completed",
  "analysis.started",
  "finding.created",
  "run.progress",
  "report.completed",
  "run.cancelled",
  "run.failed",
]);

export type SSESupportedEvent = z.infer<typeof SSESupportedEventEnum>;

// ── Canonical wire envelope ───────────────────────────────────────────────
// Every named SSE event wraps its payload in this envelope.
// The envelope.data field contains the event-specific payload.
export const SSEEnvelopeSchema = z.object({
  type: SSESupportedEventEnum,
  timestamp: z.string().datetime({ message: "timestamp must be ISO-8601" }),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type SSEEnvelope = z.infer<typeof SSEEnvelopeSchema>;

// ── Event-specific payload schemas ────────────────────────────────────────
// These must match the payloads FlowDeck actually emits.

export const SSEConnectedPayloadSchema = z.object({
  clientId: z.string().min(1),
}).strict();
export type SSEConnectedPayload = z.infer<typeof SSEConnectedPayloadSchema>;

export const SSEHeartbeatPayloadSchema = z.object({
  time: z.string().min(1),
}).strict();
export type SSEHeartbeatPayload = z.infer<typeof SSEHeartbeatPayloadSchema>;

export const SSERunQueuedPayloadSchema = z.object({
  runId: z.string().min(1),
  status: z.literal("queued").optional(),
  stage: z.string().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
}).strict();
export type SSERunQueuedPayload = z.infer<typeof SSERunQueuedPayloadSchema>;

export const SSERunStartedPayloadSchema = z.object({
  runId: z.string().min(1),
  status: z.literal("running").optional(),
  stage: z.string().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
}).strict();
export type SSERunStartedPayload = z.infer<typeof SSERunStartedPayloadSchema>;

export const SSECollectorStartedPayloadSchema = z.object({
  runId: z.string().min(1),
}).strict();
export type SSECollectorStartedPayload = z.infer<typeof SSECollectorStartedPayloadSchema>;

export const SSECollectorCompletedPayloadSchema = z.object({
  runId: z.string().min(1),
  evidenceCount: z.number().int().nonnegative(),
}).strict();
export type SSECollectorCompletedPayload = z.infer<typeof SSECollectorCompletedPayloadSchema>;

export const SSEAnalysisStartedPayloadSchema = z.object({
  runId: z.string().min(1),
}).strict();
export type SSEAnalysisStartedPayload = z.infer<typeof SSEAnalysisStartedPayloadSchema>;

export const SSEFindingCreatedPayloadSchema = z.object({
  runId: z.string().min(1),
  findingCount: z.number().int().nonnegative(),
}).strict();
export type SSEFindingCreatedPayload = z.infer<typeof SSEFindingCreatedPayloadSchema>;

export const SSERunProgressPayloadSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  stage: z.string(),
  progressPercent: z.number().min(0).max(100),
  updatedAt: z.string(),
  errorMessage: z.string().optional(),
}).strict();
export type SSERunProgressPayload = z.infer<typeof SSERunProgressPayloadSchema>;

export const SSEReportCompletedPayloadSchema = z.object({
  runId: z.string().min(1),
}).strict();
export type SSEReportCompletedPayload = z.infer<typeof SSEReportCompletedPayloadSchema>;

export const SSERunCancelledPayloadSchema = z.object({
  runId: z.string().min(1),
  errorMessage: z.string().optional(),
}).strict();
export type SSERunCancelledPayload = z.infer<typeof SSERunCancelledPayloadSchema>;

export const SSERunFailedPayloadSchema = z.object({
  runId: z.string().min(1),
  errorMessage: z.string(),
}).strict();
export type SSERunFailedPayload = z.infer<typeof SSERunFailedPayloadSchema>;

// ── Payload validator dispatcher ──────────────────────────────────────────

export function getPayloadValidator(
  eventType: SSESupportedEvent,
): z.ZodType<unknown> {
  switch (eventType) {
    case "connected":
      return SSEConnectedPayloadSchema;
    case "heartbeat":
      return SSEHeartbeatPayloadSchema;
    case "run.queued":
      return SSERunQueuedPayloadSchema;
    case "run.started":
      return SSERunStartedPayloadSchema;
    case "collector.started":
      return SSECollectorStartedPayloadSchema;
    case "collector.completed":
      return SSECollectorCompletedPayloadSchema;
    case "analysis.started":
      return SSEAnalysisStartedPayloadSchema;
    case "finding.created":
      return SSEFindingCreatedPayloadSchema;
    case "run.progress":
      return SSERunProgressPayloadSchema;
    case "report.completed":
      return SSEReportCompletedPayloadSchema;
    case "run.failed":
      return SSERunFailedPayloadSchema;
    case "run.cancelled":
      return SSERunCancelledPayloadSchema;
  }
}
