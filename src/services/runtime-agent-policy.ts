/**
 * Runtime Agent Policy
 *
 * Enforces that top-level user messages use the expected primary agent.
 * Prevents silent agent substitution (e.g., "build" overriding default_agent: "heidi").
 *
 * Session classification uses authoritative parent metadata from the plugin client,
 * NOT substring matching on session IDs.
 *
 * Synthetic/internal message detection uses message role and flags,
 * NOT model variant name inspection.
 *
 * Identity anti-fabrication:
 *   - Match (heidi, heidi): adds Heidi identity marker
 *   - Warn/off mismatch (build, heidi): adds actual-agent marker
 *   - Strict mismatch: blocks before LLM call
 *
 * Auditing: every evaluated message records decision regardless of mode.
 */

import { appendAuditEvent, redactAuditData } from "./audit-log"
import type { FlowDeckConfig } from "../config/schema"

export type RuntimeAgentMode = "strict" | "warn" | "off"

export interface RuntimeAgentConfig {
  enforcement: RuntimeAgentMode
  expectedAgent?: string
}

/**
 * Resolved session metadata provided by the chat.message hook.
 * The hook is responsible for reading authoritative data from the plugin client.
 */
export interface RuntimeAgentContext {
  /** Whether this message belongs to a top-level (non-child) session */
  isTopLevel: boolean
  /** Whether this message is authored by a real user (not synthetic/internal) */
  isUserMessage: boolean
  /** The resolved agent for this message */
  agent: string
  /** Session ID for audit correlation */
  sessionID: string
  /** Package version for audit */
  packageVersion: string
}

export interface RuntimeAgentResult {
  allowed: boolean
  match: boolean
  reason?: string
  identityMarker: string | null
}

const DEFAULT_EXPECTED_AGENT = "heidi"
const DEFAULT_MODE: RuntimeAgentMode = "strict"

/**
 * Resolve the effective runtime agent configuration.
 */
export function resolveRuntimeAgentConfig(
  flowdeckConfig: FlowDeckConfig,
  effectiveDefaultAgent?: string,
): RuntimeAgentConfig {
  const raw = (flowdeckConfig as any)?.runtimeAgent as RuntimeAgentConfig | undefined
  return {
    enforcement: raw?.enforcement ?? DEFAULT_MODE,
    expectedAgent: raw?.expectedAgent ?? effectiveDefaultAgent ?? DEFAULT_EXPECTED_AGENT,
  }
}

/**
 * Evaluate and enforce runtime agent identity.
 *
 * Accepts resolved session metadata — the caller (chat.message hook)
 * is responsible for providing authoritative context (parentID, role, flags).
 */
export function evaluateRuntimeAgentPolicy(
  context: RuntimeAgentContext,
  config: RuntimeAgentConfig,
  directory: string,
): RuntimeAgentResult {
  const { isTopLevel, isUserMessage, agent, sessionID } = context
  const { enforcement, expectedAgent } = config
  const effectiveExpected = expectedAgent ?? DEFAULT_EXPECTED_AGENT

  // Only enforce on top-level user-authored messages
  if (!isTopLevel || !isUserMessage) {
    return {
      allowed: true,
      match: true,
      identityMarker: buildIdentityMarker(agent, effectiveExpected),
    }
  }

  const resolvedAgent = agent || "unknown"
  const isMatch = resolvedAgent === effectiveExpected

  // Build audit entry
  const auditEntry = {
    kind: isMatch ? "session.agent_verified" as const : "session.agent_mismatch" as const,
    session_id: sessionID,
    agent: resolvedAgent,
    decision: isMatch ? "allow" as const : enforcement === "strict" ? "block" as const : enforcement === "warn" ? "warn" as const : "allow" as const,
    reason: isMatch
      ? `Runtime agent "${resolvedAgent}" matches expected "${effectiveExpected}"`
      : `Configured primary agent is "${effectiveExpected}", but this request selected "${resolvedAgent}". Select ${effectiveExpected} or change runtimeAgent.enforcement/default_agent explicitly.`,
  }

  // Record audit with redaction
  const redactedEntry = redactAuditData(auditEntry)
  appendAuditEvent(directory, redactedEntry)

  if (isMatch) {
    return {
      allowed: true,
      match: true,
      identityMarker: buildIdentityMarker(resolvedAgent, effectiveExpected),
    }
  }

  // Mismatch — enforcement mode decides
  if (enforcement === "strict") {
    return {
      allowed: false,
      match: false,
      reason: `FLOWDECK_AGENT_MISMATCH:\nConfigured primary agent is "${effectiveExpected}", but this request selected "${resolvedAgent}". Select ${effectiveExpected} or change runtimeAgent.enforcement/default_agent explicitly.`,
      identityMarker: null,
    }
  }

  // warn or off: allow, but attach the actual-agent identity marker
  return {
    allowed: true,
    match: false,
    identityMarker: buildIdentityMarker(resolvedAgent, effectiveExpected),
  }
}

/**
 * Build the identity anti-fabrication system marker.
 *
 * When agents match (heidi/heidi):
 *   "Runtime agent ID: heidi. You are the FlowDeck Heidi coordinator."
 *
 * When agents mismatch (build/heidi) in warn/off mode:
 *   "Runtime agent ID: build. You are OpenCode agent \"build\".
 *    Do not claim to be Heidi, FlowDeck Heidi, or the FlowDeck coordinator."
 */
export function buildIdentityMarker(agent: string, expectedAgent: string): string | null {
  if (!agent) return null

  if (agent === expectedAgent && agent === "heidi") {
    return `Runtime agent ID: heidi.\nYou are the FlowDeck Heidi coordinator.`
  }

  if (agent !== expectedAgent) {
    return `Runtime agent ID: ${agent}.\nYou are OpenCode agent "${agent}".\nDo not claim to be Heidi, FlowDeck Heidi, or the FlowDeck coordinator.`
  }

  // Agent matches expected but is not "heidi" (e.g., "build"/"build")
  return `Runtime agent ID: ${agent}.\nYou are OpenCode agent "${agent}".`
}

/**
 * Apply identity marker to output.message.system.
 * Preserves existing system content — appends marker if not already present.
 * Never replaces existing content.
 */
export function appendRuntimeIdentityMarker(
  systemContent: string | undefined | null,
  marker: string | null,
): string {
  if (!marker) return systemContent || ""

  const existing = systemContent || ""
  if (existing.includes("Runtime agent ID:")) return existing
  return existing ? `${existing}\n\n${marker}` : marker
}
