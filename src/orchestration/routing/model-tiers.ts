/**
 * Model capability tiers for routing decisions.
 *
 * Defines the tier hierarchy and per-model configuration used
 * by the routing policy to select appropriate models.
 */

export interface ModelTier {
  readonly id: string;
  readonly name: "small" | "general" | "strong";
  readonly provider: string;
  readonly modelId: string;
  readonly contextSize: number;
  readonly costPer1KInput: number;
  readonly costPer1KOutput: number;
  readonly capabilities: readonly string[];
}

export interface ModelConfig {
  readonly tiers: readonly ModelTier[];
  readonly defaultTier: string;
  readonly fallbackTier: string;
}

export function getTierById(config: ModelConfig, tierId: string): ModelTier | undefined {
  return config.tiers.find((t) => t.id === tierId);
}

export function getTierByName(config: ModelConfig, name: ModelTier["name"]): ModelTier[] {
  return config.tiers.filter((t) => t.name === name);
}

export function getLowestCostTier(config: ModelConfig, capability: string): ModelTier | undefined {
  return config.tiers
    .filter((t) => t.capabilities.includes(capability))
    .sort((a, b) => a.costPer1KInput + a.costPer1KOutput - (b.costPer1KInput + b.costPer1KOutput))[0];
}

export function calculateTierCost(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1000) * tier.costPer1KInput;
  const outputCost = (outputTokens / 1000) * tier.costPer1KOutput;
  return inputCost + outputCost;
}
