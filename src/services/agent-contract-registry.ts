/**
 * Agent Contract Registry — Generated adapter over canonical-registry.ts
 *
 * This file is the single source of truth for AgentContract data.
 * It derives all contracts from the canonical registry so there is
 * no possibility of the two diverging.
 *
 * Do NOT maintain a separate hand-written CONTRACTS array here.
 * To change an agent's tools, inputs, or outputs, edit canonical-registry.ts.
 *
 * The public API (getContract, getAllContracts, listAgentsWithContracts) and
 * the AgentContract interface are preserved exactly so all existing import
 * sites compile without modification.
 */

import { getAllCanonicalAgents, type CanonicalAgentEntry } from './canonical-registry'

export interface AgentContract {
  /** Agent identifier, matching the name in AGENT_NAMES */
  agent: string
  /** One-line description of the agent's role */
  role: string
  /** Task types this agent is allowed to handle */
  allowedTaskTypes: string[]
  /** Required inputs before the agent can execute */
  requiredInputs: string[]
  /** Fields that must appear in the agent's structured output */
  expectedOutputFields: string[]
  /** Tools the agent is permitted to use */
  allowedTools: string[]
  /** Actions the agent must never perform */
  forbiddenActions: string[]
  /** Conditions that require escalation or human intervention */
  escalationConditions: string[]
  /** Conditions that should cause the agent to stop */
  stopConditions: string[]
  /** Criteria for a successful run */
  successCriteria: string[]
}

function fromCanonical(entry: CanonicalAgentEntry): AgentContract {
  return {
    agent: entry.id,
    role: entry.description,
    allowedTaskTypes: entry.allowedTaskTypes,
    requiredInputs: entry.requiredInputs,
    expectedOutputFields: entry.expectedOutput,
    allowedTools: entry.allowedTools,
    forbiddenActions: entry.forbiddenActions,
    escalationConditions: entry.escalationConditions,
    stopConditions: entry.stopConditions,
    successCriteria: entry.successCriteria,
  }
}

// Derived once at module load — no separate maintenance required.
const CONTRACTS: AgentContract[] = getAllCanonicalAgents().map(fromCanonical)
const REGISTRY = new Map<string, AgentContract>(CONTRACTS.map(c => [c.agent, c]))

export function getContract(agent: string): AgentContract | null {
  return REGISTRY.get(agent) ?? null
}

export function getAllContracts(): AgentContract[] {
  return [...CONTRACTS]
}

export function listAgentsWithContracts(): string[] {
  return CONTRACTS.map(c => c.agent)
}
