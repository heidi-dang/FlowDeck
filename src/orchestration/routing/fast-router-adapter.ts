/**
 * Adapter between HeidiFastRouter decisions and FlowDeck authoritative RoutingDecision domain.
 *
 * Provides typed bi-directional mapping without `as any` casts and fails closed if evidence is malformed.
 * Uses real FlowDeck task assessment logic without fabricating risk/ambiguity or fake workstream paths.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  routingDecisionSchema,
  type RoutingDecision,
  type RoutingEvidence,
  type ExecutionStrategy,
  type BudgetProfile,
} from "./contracts/task-intelligence";
import { assessTask } from "./intelligence";
import {
  type RouterDecision,
  type ExecutionClass,
  type SpecialistDomain,
} from "../../services/heidi-fast-router";
import type { CodeModeTelemetry } from "../../services/heidi-code-mode-policy";

export const VALID_EXECUTION_CLASSES: ReadonlySet<string> = new Set<ExecutionClass>([
  "FAST_DIRECT",
  "SPECIALIST",
  "PARALLEL_SPECIALISTS",
  "STANDARD",
  "DEEP",
]);

export function isExecutionClass(val: unknown): val is ExecutionClass {
  return typeof val === "string" && VALID_EXECUTION_CLASSES.has(val);
}

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

export function resolveSourceSha(directory?: string, fallbackSha?: string): string {
  if (fallbackSha && /^[0-9a-f]{40}$/.test(fallbackSha)) {
    return fallbackSha;
  }
  if (directory) {
    try {
      const out = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      if (/^[0-9a-f]{40}$/.test(out)) return out;
    } catch {
      // Non-git directory or git error
    }
  }
  return "0".repeat(40);
}

export function buildCanonicalRoutingDecision(input: {
  runId: string;
  decision: RouterDecision;
  goal: string;
  lastUserMessageHash: string;
  directory?: string;
  sourceSha?: string;
}): RoutingDecision {
  const sourceSha = resolveSourceSha(input.directory, input.sourceSha);

  // Use real FlowDeck assessment logic to compute taskClass, complexity, ambiguity, risk
  const baseAssessment = assessTask({
    runId: input.runId,
    task: input.goal,
    sourceSha,
  });

  const additionalEvidence: RoutingEvidence[] = [
    { id: `ev-exec-class-${randomUUID().slice(0, 8)}`, kind: "classification", signal: "executionClass", value: input.decision.executionClass, weight: 100 },
    { id: `ev-user-goal-${randomUUID().slice(0, 8)}`, kind: "goal", signal: "goal", value: input.goal, weight: 100 },
    { id: `ev-msg-hash-${randomUUID().slice(0, 8)}`, kind: "hash", signal: "lastUserMessageHash", value: input.lastUserMessageHash, weight: 100 },
    { id: `ev-reason-code-${randomUUID().slice(0, 8)}`, kind: "classification", signal: "reasonCode", value: input.decision.reasonCode, weight: 100 },
    { id: `ev-confidence-${randomUUID().slice(0, 8)}`, kind: "classification", signal: "confidence", value: String(input.decision.confidence), weight: 100 },
  ];

  if (input.decision.specialists && input.decision.specialists.length > 0) {
    additionalEvidence.push({
      id: `ev-specialists-${randomUUID().slice(0, 8)}`,
      kind: "specialists",
      signal: "specialists",
      value: JSON.stringify(input.decision.specialists),
      weight: 100,
    });
  }
  if (input.decision.suggestedAgents && input.decision.suggestedAgents.length > 0) {
    additionalEvidence.push({
      id: `ev-agents-${randomUUID().slice(0, 8)}`,
      kind: "agents",
      signal: "suggestedAgents",
      value: JSON.stringify(input.decision.suggestedAgents),
      weight: 100,
    });
  }
  if (input.decision.codeModeTelemetry) {
    additionalEvidence.push({
      id: `ev-cm-telemetry-${randomUUID().slice(0, 8)}`,
      kind: "code_mode",
      signal: "telemetry",
      value: JSON.stringify(input.decision.codeModeTelemetry),
      weight: 50,
    });
  }
  if (input.decision.codeModeRejectedReason) {
    additionalEvidence.push({
      id: `ev-cm-reason-${randomUUID().slice(0, 8)}`,
      kind: "code_mode",
      signal: "rejected_reason",
      value: input.decision.codeModeRejectedReason,
      weight: 50,
    });
  }

  const combinedEvidence = [...baseAssessment.evidence, ...additionalEvidence];

  const delegations = (input.decision.suggestedAgents ?? []).map((agentId, idx) => ({
    agentId,
    capability: input.decision.specialists?.[idx] ?? "general",
    ownership: ["*"],
    rationale: input.decision.reason,
  }));

  const budgetRecommendation: BudgetProfile =
    input.decision.executionClass === "DEEP"
      ? "deep-audit"
      : input.decision.executionClass === "FAST_DIRECT"
        ? "small"
        : baseAssessment.complexity.score >= 40
          ? "audit"
          : "normal";

  const raw = {
    routingDecisionId: `rd-${randomUUID()}`,
    runId: input.runId,
    decisionVersion: 1,
    sourceSha,
    strategy: mapExecutionClassToStrategy(input.decision.executionClass),
    delegate: input.decision.executionClass === "SPECIALIST" || input.decision.executionClass === "PARALLEL_SPECIALISTS",
    delegations,
    workstreams: [], // No synthetic workstream paths invented
    budgetRecommendation,
    modelRecommendation: "default",
    rationale: [input.decision.reason, ...baseAssessment.evidence.map(e => `${e.signal}: ${e.value}`)].slice(0, 5),
    rejectedAlternatives: [],
    policyVersion: "2.0.0",
    createdAt: new Date().toISOString(),
    finalized: true as const,
    assessment: {
      ...baseAssessment,
      parallelism: input.decision.executionClass === "PARALLEL_SPECIALISTS" ? ("high" as const) : baseAssessment.parallelism,
      evidence: combinedEvidence,
    },
  };

  return routingDecisionSchema.parse(raw);
}

export function reconstructRouterDecision(decision: RoutingDecision): {
  decision: RouterDecision;
  goal: string;
  lastUserMessageHash: string;
} | null {
  if (!decision || !decision.assessment || !Array.isArray(decision.assessment.evidence)) {
    return null;
  }

  const evMap = new Map<string, string>();
  for (const ev of decision.assessment.evidence) {
    if (ev && typeof ev.signal === "string" && typeof ev.value === "string") {
      evMap.set(ev.signal, ev.value);
    }
  }

  const executionClassRaw = evMap.get("executionClass");
  if (!isExecutionClass(executionClassRaw)) {
    // Fail closed: malformed or missing executionClass
    return null;
  }

  const goal = evMap.get("goal");
  if (!goal || typeof goal !== "string") {
    // Fail closed: missing goal
    return null;
  }

  const lastUserMessageHash = evMap.get("lastUserMessageHash");
  if (!lastUserMessageHash || typeof lastUserMessageHash !== "string") {
    // Fail closed: missing message hash
    return null;
  }

  const reasonCode = evMap.get("reasonCode");
  if (!reasonCode || typeof reasonCode !== "string") {
    // Fail closed: missing reason code
    return null;
  }

  const confidenceStr = evMap.get("confidence");
  const confidence = confidenceStr !== undefined ? Number(confidenceStr) : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    // Fail closed: invalid confidence
    return null;
  }

  let specialists: SpecialistDomain[] | undefined;
  if (evMap.has("specialists")) {
    try {
      specialists = JSON.parse(evMap.get("specialists")!);
    } catch {
      return null;
    }
  }

  let suggestedAgents: string[] | undefined;
  if (evMap.has("suggestedAgents")) {
    try {
      suggestedAgents = JSON.parse(evMap.get("suggestedAgents")!);
    } catch {
      return null;
    }
  }

  let codeModeTelemetry: CodeModeTelemetry | undefined;
  if (evMap.has("telemetry")) {
    try {
      codeModeTelemetry = JSON.parse(evMap.get("telemetry")!);
    } catch {
      return null;
    }
  }

  const codeModeRejectedReason = evMap.get("rejected_reason");

  const routerDecision: RouterDecision = {
    executionClass: executionClassRaw,
    reason: decision.rationale[0] || "Restored from authoritative routing decision",
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
