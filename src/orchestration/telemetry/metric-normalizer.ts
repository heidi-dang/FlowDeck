import type {
  TokenMetrics,
  ToolMetrics,
  SpecialistTokenMetrics,
} from "./self-host-report-schema.js";
import { TokenMetricsSchema, ToolMetricsSchema } from "./self-host-report-schema.js";

// ── Provider normalization ────────────────────────────────────────────────────

export interface NormalizedTokenMetrics extends TokenMetrics {
  provider: string;
  modelFamily?: string;
  rawMetrics?: Record<string, unknown>;
}

export interface NormalizedToolMetrics extends ToolMetrics {
  provider?: string;
  rawMetrics?: Record<string, unknown>;
}

// ── Cost estimation ───────────────────────────────────────────────────────────

interface CostRate {
  inputPer1MTokens: number;
  outputPer1MTokens: number;
  reasoningPer1MTokens?: number;
}

const PROVIDER_COST_RATES: Record<string, CostRate> = {
  openai: {
    inputPer1MTokens: 2.5,
    outputPer1MTokens: 10.0,
    reasoningPer1MTokens: 0,
  },
  anthropic: {
    inputPer1MTokens: 3.0,
    outputPer1MTokens: 15.0,
    reasoningPer1MTokens: 3.0,
  },
  google: {
    inputPer1MTokens: 1.25,
    outputPer1MTokens: 5.0,
  },
  azure: {
    inputPer1MTokens: 2.5,
    outputPer1MTokens: 10.0,
  },
  local: {
    inputPer1MTokens: 0,
    outputPer1MTokens: 0,
  },
};

/**
 * Estimates cost in USD based on token usage and provider.
 * Falls back to OpenAI rates for unknown providers.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number = 0,
  provider: string = "openai",
): number {
  const rates = PROVIDER_COST_RATES[provider.toLowerCase()] ?? PROVIDER_COST_RATES["openai"];
  const inputCost = (inputTokens / 1_000_000) * rates.inputPer1MTokens;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPer1MTokens;
  const reasoningCost = rates.reasoningPer1MTokens
    ? (reasoningTokens / 1_000_000) * rates.reasoningPer1MTokens
    : 0;
  return inputCost + outputCost + reasoningCost;
}

/**
 * Extracts provider name from model identifier string.
 */
export function extractProvider(modelIdentifier: string): string {
  const lower = modelIdentifier.toLowerCase();
  if (lower.includes("gpt")) return "openai";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("azure") || lower.includes("microsoft")) return "azure";
  if (lower.includes("ollama") || lower.includes("local")) return "local";
  return "unknown";
}

/**
 * Normalizes a raw token metrics record from any provider format
 * into the canonical TokenMetrics shape.
 */
export function normalizeTokenMetrics(
  raw: Record<string, unknown>,
  _defaultProvider: string = "unknown",
): NormalizedTokenMetrics {
  const provider = (raw.provider as string) ?? extractProvider((raw.model as string) ?? "");
  const inputTokens = Number(raw.inputTokens ?? raw.prompt_tokens ?? raw.input ?? 0);
  const outputTokens = Number(raw.outputTokens ?? raw.completion_tokens ?? raw.output ?? 0);
  const reasoningTokens = Number(raw.reasoningTokens ?? raw.thinking_tokens ?? 0);
  const cacheReads = Number(raw.cacheReads ?? raw.cache_hits ?? 0);
  const cacheWrites = Number(raw.cacheWrites ?? raw.cache_writes ?? 0);
  const contextWindowSize = Number(raw.contextWindowSize ?? raw.max_tokens ?? raw.context_window ?? 0);
  const compactions = Number(raw.compactions ?? raw.context_compactions ?? 0);
  const duplicatedContextEstimate = Number(raw.duplicatedContextEstimate ?? raw.duplicate_tokens ?? 0);

  const estimatedCostUsd = estimateCost(inputTokens, outputTokens, reasoningTokens, provider);

  return TokenMetricsSchema.parse({
    provider,
    modelIdentifier: (raw.model as string) ?? (raw.modelIdentifier as string),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReads,
    cacheWrites,
    estimatedCostUsd: Number(raw.estimatedCostUsd ?? estimatedCostUsd),
    contextWindowSize,
    compactions,
    duplicatedContextEstimate,
  }) as NormalizedTokenMetrics & { provider: string };
}

/**
 * Normalizes per-specialist token metrics from a map of specialist IDs
 * to their raw metric records.
 */
export function normalizeSpecialistTokenMetrics(
  perSpecialistRaw: Record<string, Record<string, unknown>>,
): SpecialistTokenMetrics {
  const perSpecialist: TokenMetrics[] = Object.entries(perSpecialistRaw).map(
    ([_specialistId, raw]) => ({
      ...normalizeTokenMetrics(raw),
      provider: (raw.provider as string) ?? extractProvider((raw.model as string) ?? ""),
    }),
  );

  // Aggregate for Heidi (main session)
  const heidiRaw = perSpecialistRaw["heidi"] ?? perSpecialistRaw["main"] ?? {};
  const heidi = normalizeTokenMetrics(heidiRaw, "openai");

  return {
    perSpecialist,
    heidi,
  };
}

/**
 * Normalizes tool metrics from raw provider data.
 */
export function normalizeToolMetrics(raw: Record<string, unknown>): NormalizedToolMetrics {
  return ToolMetricsSchema.parse({
    totalCalls: Number(raw.totalCalls ?? raw.total_calls ?? raw.calls ?? 0),
    successfulCalls: Number(raw.successfulCalls ?? raw.successful_calls ?? raw.success ?? 0),
    failedCalls: Number(raw.failedCalls ?? raw.failed_calls ?? raw.errors ?? 0),
    blockedCalls: Number(raw.blockedCalls ?? raw.blocked_calls ?? 0),
    retries: Number(raw.retries ?? raw.retry_count ?? 0),
    cancellations: Number(raw.cancellations ?? raw.cancelled ?? 0),
    nativeFdxCalls: Number(raw.nativeFdxCalls ?? raw.fdx_calls ?? raw.native_calls ?? 0),
    fallbackCalls: Number(raw.fallbackCalls ?? raw.fallback_calls ?? 0),
    cacheHits: Number(raw.cacheHits ?? raw.cache_hits ?? 0),
    cacheMisses: Number(raw.cacheMisses ?? raw.cache_misses ?? 0),
    batchedOperations: Number(raw.batchedOperations ?? raw.batched_ops ?? 0),
    redundantCalls: Number(raw.redundantCalls ?? raw.redundant_calls ?? 0),
    duplicatedQueries: Number(raw.duplicatedQueries ?? raw.duplicate_queries ?? 0),
    outputBytes: Number(raw.outputBytes ?? raw.output_bytes ?? 0),
    truncatedOutputs: Number(raw.truncatedOutputs ?? raw.truncated ?? 0),
    provider: raw.provider as string | undefined,
    rawMetrics: raw,
  });
}

/**
 * Merges multiple token metric records, summing numeric fields.
 */
export function mergeTokenMetrics(records: TokenMetrics[]): TokenMetrics {
  return {
    inputTokens: records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    outputTokens: records.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
    reasoningTokens: records.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0),
    cacheReads: records.reduce((sum, r) => sum + (r.cacheReads ?? 0), 0),
    cacheWrites: records.reduce((sum, r) => sum + (r.cacheWrites ?? 0), 0),
    estimatedCostUsd: records.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0),
    compactions: records.reduce((sum, r) => sum + (r.compactions ?? 0), 0),
    duplicatedContextEstimate: records.reduce((sum, r) => sum + (r.duplicatedContextEstimate ?? 0), 0),
  };
}

/**
 * Merges multiple tool metric records, summing numeric fields.
 */
export function mergeToolMetrics(records: ToolMetrics[]): ToolMetrics {
  return {
    totalCalls: records.reduce((sum, r) => sum + (r.totalCalls ?? 0), 0),
    successfulCalls: records.reduce((sum, r) => sum + (r.successfulCalls ?? 0), 0),
    failedCalls: records.reduce((sum, r) => sum + (r.failedCalls ?? 0), 0),
    blockedCalls: records.reduce((sum, r) => sum + (r.blockedCalls ?? 0), 0),
    retries: records.reduce((sum, r) => sum + (r.retries ?? 0), 0),
    cancellations: records.reduce((sum, r) => sum + (r.cancellations ?? 0), 0),
    nativeFdxCalls: records.reduce((sum, r) => sum + (r.nativeFdxCalls ?? 0), 0),
    fallbackCalls: records.reduce((sum, r) => sum + (r.fallbackCalls ?? 0), 0),
    cacheHits: records.reduce((sum, r) => sum + (r.cacheHits ?? 0), 0),
    cacheMisses: records.reduce((sum, r) => sum + (r.cacheMisses ?? 0), 0),
    batchedOperations: records.reduce((sum, r) => sum + (r.batchedOperations ?? 0), 0),
    redundantCalls: records.reduce((sum, r) => sum + (r.redundantCalls ?? 0), 0),
    duplicatedQueries: records.reduce((sum, r) => sum + (r.duplicatedQueries ?? 0), 0),
    outputBytes: records.reduce((sum, r) => sum + (r.outputBytes ?? 0), 0),
    truncatedOutputs: records.reduce((sum, r) => sum + (r.truncatedOutputs ?? 0), 0),
  };
}

/**
 * Deduplicates a list of token metric records by provider,
 * merging records for the same provider.
 */
export function deduplicateByProvider(records: TokenMetrics[]): TokenMetrics[] {
  const byProvider = new Map<string, TokenMetrics>();
  for (const record of records) {
    const provider = record.provider ?? "unknown";
    const existing = byProvider.get(provider);
    if (existing) {
      byProvider.set(provider, mergeTokenMetrics([existing, record]));
    } else {
      byProvider.set(provider, record);
    }
  }
  return Array.from(byProvider.values());
}
