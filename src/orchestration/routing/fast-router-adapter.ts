/**
 * Adapter between HeidiFastRouter decisions and FlowDeck authoritative RoutingDecision domain.
 *
 * Provides typed bi-directional mapping without `as any` casts.
 * Persists routing decisions into the append-only events table via SqliteRoutingDecisionRepository.
 */

import { randomUUID } from "node:crypto";
import {
  routingDecisionSchema,
  type RoutingDecision,
  type RoutingEvidence,
  type ExecutionStrategy,
} from "./contracts/task-intelligence";
import type { RouterDecision, ExecutionClass, SpecialistDomain } from "../../services/heidi-fast-router";
import type { CodeModeTelemetry } from "../../services/heidi-code-mode-policy";

export function mapExecutionClassToStrategy(cls: ExecutionClass): ExecutionStrategy {
  switch (cls) {
    case "FAST_DIRECT": return "direct";
    case "SPECIALIST": return "investigate_then_direct";
    case "PARALLEL_SPECIALISTS": return "parallel_implementation";
    case "STANDARD": return "plan_then_execute";
    case "DEEP": return "audit_only";
  }
}

export function mapExecutionClassToRunStrategy(cls: ExecutionClass): "simple" | "planned" | "delegated" | "audit" {
  switch (cls) {
    case "FAST_DIRECT": return "simple";
    case "SPECIALIST": return "delegated";
    case "PARALLEL_SPECIALISTS": return "delegated";
    case "STANDARD": return "planned";
    case "DEEP": return "audit";
  }
}

export function buildCanonicalRoutingDecision(input: {
  runId: string;
  decision: RouterDecision;
  goal: string;
  lastUserMessageHash: string;
  sourceSha?: string;
}): RoutingDecision {
  const now = new Date().toISOString();
  const sourceSha = input.sourceSha ?? "0000000000000000000000000000000000000000";

  const evidence: RoutingEvidence[] = [
    { id: "ev-execution-class", kind: "classification", signal: "executionClass", value: input.decision.executionClass, weight: 100 },
    { id: "ev-user-goal", kind: "goal", signal: "goal", value: input.goal, weight: 100 },
    { id: "ev-message-hash", kind: "hash", signal: "lastUserMessageHash", value: input.lastUserMessageHash, weight: 100 },
    { id: "ev-reason-code", kind: "classification", signal: "reasonCode", value: input.decision.reasonCode, weight: 100 },
    { id: "ev-confidence", kind: "classification", signal: "confidence", value: String(input.decision.confidence), weight: 100 },
  ];

  if (input.decision.specialists && input.decision.specialists.length > 0) {
    evidence.push({ id: "ev-specialists", kind: "specialists", signal: "specialists", value: JSON.stringify(input.decision.specialists), weight: 100 });
  }
  if (input.decision.suggestedAgents && input.decision.suggestedAgents.length > 0) {
    evidence.push({ id: "ev-suggested-agents", kind: "agents", signal: "suggestedAgents", value: JSON.stringify(input.decision.suggestedAgents), weight: 100 });
  }
  if (input.decision.codeModeTelemetry) {
    evidence.push({ id: "ev-code-mode-telemetry", kind: "code_mode", signal: "telemetry", value: JSON.stringify(input.decision.codeModeTelemetry), weight: 50 });
  }
  if (input.decision.codeModeRejectedReason) {
    evidence.push({ id: "ev-code-mode-rejected-reason", kind: "code_mode", signal: "rejected_reason", value: input.decision.codeModeRejectedReason, weight: 50 });
  }

  const scoreEvidence: RoutingEvidence[] = [
    { id: "ev-score-primary", kind: "score", signal: "primary", value: String(input.decision.confidence), weight: 100 }
  ];

  const delegations = (input.decision.suggestedAgents ?? []).map((agentId, idx) => ({
    agentId,
    capability: input.decision.specialists?.[idx] ?? "general",
    ownership: ["*"],
    rationale: input.decision.reason,
  }));

  const workstreams = input.decision.executionClass === "PARALLEL_SPECIALISTS"
    ? (input.decision.specialists ?? []).map((spec, idx) => ({
        id: `ws-${spec.toLowerCase()}-${idx}`,
        ownership: [`src/${spec.toLowerCase()}/*`],
        dependsOn: [],
        rationale: `Parallel workstream for ${spec}`,
      }))
    : [];

  const raw = {
    routingDecisionId: `rd-${randomUUID()}`,
    runId: input.runId,
    decisionVersion: 1,
    sourceSha,
    strategy: mapExecutionClassToStrategy(input.decision.executionClass),
    delegate: input.decision.executionClass === "SPECIALIST" || input.decision.executionClass === "PARALLEL_SPECIALISTS",
    delegations,
    workstreams,
    budgetRecommendation: input.decision.executionClass === "DEEP" ? ("audit" as const) : input.decision.executionClass === "FAST_DIRECT" ? ("small" as const) : ("normal" as const),
    modelRecommendation: "default",
    rationale: [input.decision.reason],
    rejectedAlternatives: [],
    policyVersion: "2.0.0",
    createdAt: now,
    finalized: true as const,
    assessment: {
      assessmentId: `assess-${randomUUID()}`,
      runId: input.runId,
      taskClass: "feature" as const,
      complexity: { score: Math.round(input.decision.confidence * 100), evidence: scoreEvidence },
      ambiguity: { score: 10, evidence: scoreEvidence },
      risk: { score: 10, evidence: scoreEvidence },
      parallelism: input.decision.executionClass === "PARALLEL_SPECIALISTS" ? ("high" as const) : ("none" as const),
      evidence,
      classifierVersion: "2.0.0",
      policyVersion: "2.0.0",
      createdAt: now,
    },
  };

  return routingDecisionSchema.parse(raw);
}

export function reconstructRouterDecision(decision: RoutingDecision): { decision: RouterDecision; goal: string; lastUserMessageHash: string } {
  const evMap = new Map<string, string>();
  for (const ev of decision.assessment.evidence) {
    evMap.set(ev.signal, ev.value);
  }

  const executionClass = (evMap.get("executionClass") as ExecutionClass) ?? "STANDARD";
  const goal = evMap.get("goal") ?? "Unknown goal";
  const lastUserMessageHash = evMap.get("lastUserMessageHash") ?? "unknown";
  const reasonCode = evMap.get("reasonCode") ?? "RESTORED";
  const confidence = evMap.has("confidence") ? Number(evMap.get("confidence")) : 0.8;
  const specialists = evMap.has("specialists") ? (JSON.parse(evMap.get("specialists")!) as SpecialistDomain[]) : undefined;
  const suggestedAgents = evMap.has("suggestedAgents") ? (JSON.parse(evMap.get("suggestedAgents")!) as string[]) : undefined;
  const codeModeTelemetry = evMap.has("telemetry") ? (JSON.parse(evMap.get("telemetry")!) as CodeModeTelemetry) : undefined;
  const codeModeRejectedReason = evMap.get("rejected_reason");

  const routerDecision: RouterDecision = {
    executionClass,
    reason: decision.rationale[0] ?? "Restored from authoritative routing decision",
    reasonCode,
    confidence,
    forcedByExplicitSignal: false,
    specialists,
    suggestedAgents,
    codeModeTelemetry,
    codeModeRejectedReason,
  };

  return { decision: routerDecision, goal, lastUserMessageHash };
}
