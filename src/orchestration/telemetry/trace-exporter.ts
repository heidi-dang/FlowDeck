import type { Span } from "../tracing/index.js";

// ── Trace export formats ──────────────────────────────────────────────────────

export type TraceExportFormat = "json" | "ndjson" | "opentelemetry" | "jaeger";

export interface TraceExportOptions {
  format?: TraceExportFormat;
  includeEvents?: boolean;
  includeAttributes?: boolean;
  compress?: boolean;
}

// ── JSON trace export ─────────────────────────────────────────────────────────

export interface ExportedSpan {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
  events?: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
  status?: { code: number; message?: string };
}

function spanToExportedSpan(span: Span, includeEvents: boolean, includeAttributes: boolean): ExportedSpan {
  return {
    name: span.name,
    spanId: span.spanId,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId,
    startTime: span.startTime,
    endTime: span.endTime,
    durationMs: span.endTime ? span.endTime - span.startTime : undefined,
    attributes: includeAttributes ? span.attributes : undefined,
    events: includeEvents ? span.events : undefined,
    status: span.status,
  };
}

export function exportSpansToJson(spans: Span[], options: TraceExportOptions = {}): string {
  const { includeEvents = true, includeAttributes = true } = options;
  const exported = spans.map((s) => spanToExportedSpan(s, includeEvents, includeAttributes));
  return JSON.stringify(exported, null, 2);
}

export function exportSpansToNdjson(spans: Span[], options: TraceExportOptions = {}): string {
  const { includeEvents = true, includeAttributes = true } = options;
  return spans
    .map((s) => JSON.stringify(spanToExportedSpan(s, includeEvents, includeAttributes)))
    .join("\n");
}

// ── OpenTelemetry trace export ────────────────────────────────────────────────

export interface OtelSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
  events: Array<{ timeUnixNano: string; name: string; attributes?: Array<{ key: string; value: { stringValue?: string } }> }>;
  status: { code: number; message?: string };
}

export interface OtelTraceExport {
  schemaUrl: string;
  spans: OtelSpan[];
}

function toOtelAttributeValue(value: string | number | boolean): OtelSpan["attributes"][0]["value"] {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { intValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: String(value) };
}

function toOtelEventAttribute(attr: Record<string, unknown>): OtelSpan["events"][0]["attributes"] {
  return Object.entries(attr).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
}

export function exportSpansToOpenTelemetry(spans: Span[]): OtelTraceExport {
  const nowNs = Date.now() * 1_000_000;
  return {
    schemaUrl: "https://opentelemetry.io/schemas/1.24.0",
    spans: spans.map((s): OtelSpan => ({
      spanId: s.spanId,
      traceId: s.traceId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      kind: 1, // Internal
      startTimeUnixNano: String(s.startTime * 1_000_000),
      endTimeUnixNano: s.endTime ? String(s.endTime * 1_000_000) : String(nowNs),
      attributes: Object.entries(s.attributes).map(([key, value]) => ({
        key,
        value: toOtelAttributeValue(value),
      })),
      events: s.events.map((e) => ({
        timeUnixNano: String(e.timestamp * 1_000_000),
        name: e.name,
        attributes: e.attributes ? toOtelEventAttribute(e.attributes) : undefined,
      })),
      status: s.status ?? { code: 1 }, // UNSET = 1
    })),
  };
}

// ── Jaeger trace export ──────────────────────────────────────────────────────

export interface JaegerSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  flags: number;
  startTime: number;
  duration: number;
  tags: Array<{ key: string; type: string; value: unknown }>;
  logs: Array<{ timestamp: number; fields: Array<{ key: string; type: string; value: unknown }> }>;
}

export interface JaegerTrace {
  "service.name": string;
  "entity.name"?: string;
  spans: JaegerSpan[];
}

function toJaegerTagValue(value: string | number | boolean): { type: string; value: unknown } {
  if (typeof value === "string") return { type: "STRING", value };
  if (typeof value === "number") return { type: "FLOAT64", value };
  if (typeof value === "boolean") return { type: "BOOL", value };
  return { type: "STRING", value: String(value) };
}

export function exportSpansToJaeger(spans: Span[], serviceName: string = "flowdeck"): JaegerTrace {
  return {
    "service.name": serviceName,
    spans: spans.map((s): JaegerSpan => ({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      operationName: s.name,
      flags: s.status?.code === 2 ? 1 : 0, // ERROR = 2
      startTime: s.startTime,
      duration: s.endTime ? s.endTime - s.startTime : 0,
      tags: Object.entries(s.attributes).map(([key, value]) => ({
        key,
        ...toJaegerTagValue(value),
      })),
      logs: s.events.map((e) => ({
        timestamp: e.timestamp,
        fields: Object.entries(e.attributes ?? {}).map(([k, v]) => ({
          key: k,
          type: "STRING",
          value: String(v),
        })),
      })),
    })),
  };
}

// ── Unified export function ───────────────────────────────────────────────────

export interface TraceExportResult {
  content: string;
  format: TraceExportFormat;
  byteLength: number;
}

export function exportTraces(
  spans: Span[],
  options: TraceExportOptions = {},
): TraceExportResult {
  const format = options.format ?? "json";
  let content: string;

  switch (format) {
    case "ndjson":
      content = exportSpansToNdjson(spans, options);
      break;
    case "opentelemetry":
      content = JSON.stringify(exportSpansToOpenTelemetry(spans), null, 2);
      break;
    case "jaeger":
      content = JSON.stringify(exportSpansToJaeger(spans), null, 2);
      break;
    case "json":
    default:
      content = exportSpansToJson(spans, options);
      break;
  }

  return {
    content,
    format,
    byteLength: Buffer.byteLength(content, "utf-8"),
  };
}

export function exportTracesToFile(
  spans: Span[],
  filePath: string,
  options: TraceExportOptions = {},
): TraceExportResult {
  const fs = require("fs") as typeof import("fs");
  const result = exportTraces(spans, options);
  fs.writeFileSync(filePath, result.content, "utf-8");
  return result;
}
