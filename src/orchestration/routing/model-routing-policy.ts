/**
 * Model routing policy for selecting appropriate models based on task characteristics.
 *
 * Policy principles:
 * - Start with least expensive model that historically succeeds
 * - Escalate only when evidence supports escalation
 * - Never silently downgrade below required capability floor
 */

import { type ModelConfig, type ModelTier, getLowestCostTier, calculateTierCost } from "./model-tiers";
import { type ProviderHealthMonitor } from "./provider-health";

export type Complexity = "low" | "medium" | "high";
export type Ambiguity = "low" | "medium" | "high";
export type Risk = "low" | "medium" | "high";
export type ExpectedOutput = "short" | "medium" | "long";
export type StartStrategy = "least_expensive" | "historical_success" | "capability_match";

export interface RoutingInput {
  readonly complexity: Complexity;
  readonly ambiguity: Ambiguity;
  readonly risk: Risk;
  readonly contextTokens: number;
  readonly historicalSuccess?: ReadonlyMap<string, number>; // modelId -> success rate (0-1)
  readonly expectedOutput: ExpectedOutput;
  readonly latencyPriority: number; // 0-1
  readonly costPriority: number; // 0-1
  readonly requiredCapabilities?: readonly string[];
  readonly capabilityFloor?: ModelTier["name"];
}

export interface RoutingDecision {
  readonly selectedModel: string;
  readonly tier: string;
  readonly reason: string;
  readonly escalation?: string;
  readonly startWith: StartStrategy;
}

export class ModelRoutingPolicy {
  constructor(
    private readonly config: ModelConfig,
    private readonly healthMonitor: ProviderHealthMonitor,
  ) {}

  route(input: RoutingInput): RoutingDecision {
    const { capabilityFloor = "small" } = input;

    // Determine minimum acceptable tier based on capability floor
    const tierOrder: ModelTier["name"][] = ["small", "general", "strong"];
    const floorIndex = tierOrder.indexOf(capabilityFloor);

    // Find eligible tiers at or above the capability floor
    const eligibleTiers = this.config.tiers.filter((t) => tierOrder.indexOf(t.name) >= floorIndex);

    if (eligibleTiers.length === 0) {
      // Fallback to default tier if nothing meets the floor
      const defaultTier = this.config.tiers.find((t) => t.id === this.config.defaultTier);
      if (!defaultTier) {
        throw new Error(`No default tier found: ${this.config.defaultTier}`);
      }
      return {
        selectedModel: defaultTier.modelId,
        tier: defaultTier.id,
        reason: "No eligible tiers met capability floor, using default",
        startWith: "least_expensive",
      };
    }

    // Filter by required capabilities
    let capabilityEligibleTiers = eligibleTiers;
    if (input.requiredCapabilities && input.requiredCapabilities.length > 0) {
      capabilityEligibleTiers = eligibleTiers.filter((t) =>
        input.requiredCapabilities!.every((cap) => t.capabilities.includes(cap)),
      );
      if (capabilityEligibleTiers.length === 0) {
        // Escalate to higher tier if required capabilities not met
        const higherTier = this.findHigherTier(eligibleTiers, capabilityFloor);
        if (higherTier) {
          return {
            selectedModel: higherTier.modelId,
            tier: higherTier.id,
            reason: `Required capabilities not available at ${capabilityFloor}, escalated to ${higherTier.name}`,
            escalation: "capability_required",
            startWith: "capability_match",
          };
        }
        // Fallback to fallback tier
        const fallbackTier = this.config.tiers.find((t) => t.id === this.config.fallbackTier);
        if (fallbackTier) {
          return {
            selectedModel: fallbackTier.modelId,
            tier: fallbackTier.id,
            reason: "Required capabilities not available in any tier, using fallback",
            startWith: "capability_match",
          };
        }
      }
    }

    // Filter by context size
    const contextEligibleTiers = capabilityEligibleTiers.filter((t) => t.contextSize >= input.contextTokens);
    if (contextEligibleTiers.length === 0) {
      // Need larger context, escalate
      const largerTier = this.findLargerContextTier(capabilityEligibleTiers, input.contextTokens);
      if (largerTier) {
        return {
          selectedModel: largerTier.modelId,
          tier: largerTier.id,
          reason: `Context size ${input.contextTokens} exceeds current tiers, escalated`,
          escalation: "context_required",
          startWith: "capability_match",
        };
      }
    }

    // Filter by provider health
    const healthyTiers = this.filterHealthyTiers(contextEligibleTiers.length > 0 ? contextEligibleTiers : capabilityEligibleTiers);

    // Score and rank candidates
    const candidates = this.scoreCandidates(healthyTiers, input);

    if (candidates.length === 0) {
      const fallbackTier = this.config.tiers.find((t) => t.id === this.config.fallbackTier);
      if (fallbackTier) {
        return {
          selectedModel: fallbackTier.modelId,
          tier: fallbackTier.id,
          reason: "No healthy candidates, using fallback",
          startWith: "least_expensive",
        };
      }
      throw new Error("No eligible model found and no fallback available");
    }

    // Select based on start strategy
    const startStrategy = this.determineStartStrategy(input);
    const selected = this.selectByStrategy(candidates, startStrategy, input);

    return {
      selectedModel: selected.modelId,
      tier: selected.id,
      reason: this.buildReason(selected, input, startStrategy),
      startWith: startStrategy,
    };
  }

  private findHigherTier(tiers: readonly ModelTier[], currentFloor: ModelTier["name"]): ModelTier | undefined {
    const tierOrder: ModelTier["name"][] = ["small", "general", "strong"];
    const currentIndex = tierOrder.indexOf(currentFloor);
    if (currentIndex >= tierOrder.length - 1) return undefined;

    const nextTierName = tierOrder[currentIndex + 1];
    return tiers.find((t) => t.name === nextTierName);
  }

  private findLargerContextTier(tiers: readonly ModelTier[], requiredContext: number): ModelTier | undefined {
    return tiers
      .filter((t) => t.contextSize >= requiredContext)
      .sort((a, b) => a.contextSize - b.contextSize)[0];
  }

  private filterHealthyTiers(tiers: readonly ModelTier[]): ModelTier[] {
    return tiers.filter((t) => this.healthMonitor.isHealthy(t.provider));
  }

  private scoreCandidates(
    tiers: readonly ModelTier[],
    input: RoutingInput,
  ): Array<{ tier: ModelTier; score: number; historicalSuccess: number }> {
    return tiers.map((tier) => {
      let score = 0;
      const historicalSuccess = input.historicalSuccess?.get(tier.modelId) ?? 0.5;

      // Cost score (lower is better, invert for scoring)
      const costScore = 100 - (tier.costPer1KInput + tier.costPer1KOutput);

      // Capability match score
      let capabilityScore = 0;
      if (input.requiredCapabilities) {
        const matchCount = input.requiredCapabilities.filter((cap) => tier.capabilities.includes(cap)).length;
        capabilityScore = (matchCount / input.requiredCapabilities.length) * 30;
      }

      // Health score
      const health = this.healthMonitor.getHealth(tier.provider);
      const healthScore = health ? health.healthScore * 30 : 0;

      // Context efficiency score
      const contextScore = tier.contextSize >= input.contextTokens ? 10 : -100;

      score = costScore * input.costPriority + capabilityScore + healthScore + contextScore;

      return { tier, score, historicalSuccess };
    });
  }

  private determineStartStrategy(input: RoutingInput): StartStrategy {
    // If latency is critical, prefer historical success
    if (input.latencyPriority > 0.7) {
      return "historical_success";
    }
    // If cost is critical, prefer least expensive
    if (input.costPriority > 0.7) {
      return "least_expensive";
    }
    // Default to historical success
    return "historical_success";
  }

  private selectByStrategy(
    candidates: Array<{ tier: ModelTier; score: number; historicalSuccess: number }>,
    strategy: StartStrategy,
    input: RoutingInput,
  ): ModelTier {
    switch (strategy) {
      case "least_expensive":
        return [...candidates].sort((a, b) => {
          const aCost = a.tier.costPer1KInput + a.tier.costPer1KOutput;
          const bCost = b.tier.costPer1KInput + b.tier.costPer1KOutput;
          return aCost - bCost || b.historicalSuccess - a.historicalSuccess;
        })[0].tier;

      case "historical_success":
        return [...candidates].sort((a, b) => {
          // Prefer historically successful models but break ties with cost
          const successDiff = b.historicalSuccess - a.historicalSuccess;
          if (Math.abs(successDiff) > 0.1) return successDiff;
          const aCost = a.tier.costPer1KInput + a.tier.costPer1KOutput;
          const bCost = b.tier.costPer1KInput + b.tier.costPer1KOutput;
          return aCost - bCost;
        })[0].tier;

      case "capability_match":
        return candidates.sort((a, b) => b.score - a.score)[0].tier;
    }
  }

  private buildReason(tier: ModelTier, input: RoutingInput, strategy: StartStrategy): string {
    const parts: string[] = [`Selected ${tier.name} tier model ${tier.modelId}`];

    if (strategy === "least_expensive") {
      parts.push("least expensive option");
    } else if (strategy === "historical_success") {
      const success = input.historicalSuccess?.get(tier.modelId);
      if (success !== undefined) {
        parts.push(`historical success rate: ${(success * 100).toFixed(0)}%`);
      }
    } else if (strategy === "capability_match") {
      if (input.requiredCapabilities) {
        parts.push(`matched required capabilities: ${input.requiredCapabilities.join(", ")}`);
      }
    }

    return parts.join("; ");
  }
}
