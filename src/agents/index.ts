/**
 * Agent Index — Derived from canonical registry.
 *
 * AGENT_NAMES, agent modes, routing, and delegation policy are
 * ALL derived from src/services/canonical-registry.ts, which is
 * the single source of truth.
 *
 * Agent factory functions remain here but are keyed by IDs from
 * the canonical registry.
 */

import type { AgentConfig } from '@opencode-ai/sdk/v2';

import type { AgentDefinition } from './types';
import type { AgentRoute } from './routing';
export { resolvePrompt } from './types';
export type { AgentDefinition, AgentFactory } from './types';
export type { AgentRoute } from './routing';

// Import all agent factories
import { createHeidiAgent, createOrchestratorAgent } from './orchestrator';
import { createPlannerAgent } from './planner';
import {
  createBackendCoderAgent,
  createFrontendCoderAgent,
  createDevopsAgent,
} from './coder';
import { createTesterAgent } from './tester';
import { createReviewerAgent } from './reviewer';
import { createResearcherAgent } from './researcher';
import { createSecurityAuditorAgent } from './security-auditor';
import { createMapperAgent } from './mapper';
import { createDebugSpecialistAgent } from './debug';
import { createArchitectAgent } from './architect';

// ─── Derive from canonical registry ────────────────────────────────────────

import {
  getAllAgentIds,
  getPrimaryAgentIds,
  getCanonicalAgent,
} from '../services/canonical-registry';

/** All agent names registered by FlowDeck, derived from canonical registry. */
export const AGENT_NAMES: readonly string[] = getAllAgentIds() as readonly string[];

/** Agent mode classification. */
export type AgentMode = 'primary' | 'subagent' | 'all';

function isPrimaryAgent(name: string): boolean {
  return getPrimaryAgentIds().includes(name);
}

function isHiddenAgent(_name: string): boolean {
  return false; // No hidden agents in canonical registry
}

function isAllModeAgent(_name: string): boolean {
  return false; // No "all" mode agents currently
}

// ─── Factory map keyed by canonical IDs ────────────────────────────────────

type AgentFactoryFn = (
  model?: string,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
) => AgentDefinition;

const AGENT_FACTORIES: Record<string, AgentFactoryFn> = {
  'heidi': (model, customPrompt, customAppendPrompt, disabledAgents) =>
    createHeidiAgent(model, customPrompt, customAppendPrompt, disabledAgents),
  'orchestrator': (model, customPrompt, customAppendPrompt, disabledAgents) =>
    createOrchestratorAgent(model, customPrompt, customAppendPrompt, disabledAgents),
  'planner': (model, customPrompt, customAppendPrompt) =>
    createPlannerAgent(model, customPrompt, customAppendPrompt),
  'architect': (model, customPrompt, customAppendPrompt) =>
    createArchitectAgent(model, customPrompt, customAppendPrompt),
  'researcher': (model, customPrompt, customAppendPrompt) =>
    createResearcherAgent(model, customPrompt, customAppendPrompt),
  'mapper': (model, customPrompt, customAppendPrompt) =>
    createMapperAgent(model, customPrompt, customAppendPrompt),
  'backend-coder': (model, customPrompt, customAppendPrompt) =>
    createBackendCoderAgent(model, customPrompt, customAppendPrompt),
  'frontend-coder': (model, customPrompt, customAppendPrompt) =>
    createFrontendCoderAgent(model, customPrompt, customAppendPrompt),
  'devops': (model, customPrompt, customAppendPrompt) =>
    createDevopsAgent(model, customPrompt, customAppendPrompt),
  'tester': (model, customPrompt, customAppendPrompt) =>
    createTesterAgent(model, customPrompt, customAppendPrompt),
  'reviewer': (model, customPrompt, customAppendPrompt) =>
    createReviewerAgent(model, customPrompt, customAppendPrompt),
  'security-auditor': (model, customPrompt, customAppendPrompt) =>
    createSecurityAuditorAgent(model, customPrompt, customAppendPrompt),
  'debug-specialist': (model, customPrompt, customAppendPrompt) =>
    createDebugSpecialistAgent(model, customPrompt, customAppendPrompt),
};

/**
 * Create a single agent by name with optional model and custom prompts.
 * Agent name must be present in the canonical registry.
 * When model is undefined, the agent inherits the UI-selected model.
 */
export function createAgent(
  name: string,
  model?: string,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
): AgentDefinition | undefined {
  const factory = AGENT_FACTORIES[name];
  if (!factory) return undefined;
  return factory(model, customPrompt, customAppendPrompt, disabledAgents);
}

/**
 * Create all agent definitions with optional per-agent model overrides.
 * When a model is not provided for an agent, it inherits the UI-selected model.
 */
export function createAgents(
  agentModels?: Record<string, string | undefined>,
): AgentDefinition[] {
  return AGENT_NAMES
    .map(name => {
      const model = agentModels?.[name];
      return createAgent(name, model);
    })
    .filter((a): a is AgentDefinition => a !== undefined);
}

export interface GetAgentConfigsOptions {
  // No options currently.
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Modes are derived from canonical registry (primary vs subagent).
 */
export function getAgentConfigs(
  agentModels?: Record<string, string | undefined>,
  _options?: GetAgentConfigsOptions,
): Record<string, AgentConfig> {
  const agents = createAgents(agentModels);
  const configs: Record<string, AgentConfig> = {};

  for (const agent of agents) {
    let mode: 'primary' | 'subagent' | 'all' = 'subagent';
    if (isPrimaryAgent(agent.name)) {
      mode = 'primary';
    } else if (isAllModeAgent(agent.name)) {
      mode = 'all';
    }

    configs[agent.name] = {
      ...agent.config,
      description: agent.description,
      mode,
      hidden: isHiddenAgent(agent.name),
    };
  }

  return configs;
}

/**
 * Build routing list from canonical registry.
 * Excludes primary agents (heidi, orchestrator) from routes.
 */
export function getAgentRoutes(): AgentRoute[] {
  const out: AgentRoute[] = [];
  const primaryIds = new Set(getPrimaryAgentIds());

  for (const name of AGENT_NAMES) {
    if (primaryIds.has(name)) continue;
    const canonical = getCanonicalAgent(name);
    if (!canonical) continue;
    out.push({ name, description: canonical.description });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Check for registry consistency: every canonical agent must have a factory
function validateRegistryConsistency(): void {
  const canonicalIds = new Set(getAllAgentIds());
  const factoryIds = new Set(Object.keys(AGENT_FACTORIES));
  for (const id of canonicalIds) {
    if (!factoryIds.has(id)) {
      console.warn(`[flowdeck] Agent "${id}" exists in canonical registry but has no factory`);
    }
  }
  for (const id of factoryIds) {
    if (!canonicalIds.has(id)) {
      console.warn(`[flowdeck] Agent "${id}" has a factory but is not in canonical registry`);
    }
  }
}

validateRegistryConsistency();

// Export all agent factories for direct access
export {
  createHeidiAgent,
  createOrchestratorAgent,
  createPlannerAgent,
  createArchitectAgent,
  createResearcherAgent,
  createMapperAgent,
  createBackendCoderAgent,
  createFrontendCoderAgent,
  createDevopsAgent,
  createTesterAgent,
  createReviewerAgent,
  createSecurityAuditorAgent,
  createDebugSpecialistAgent,
};
