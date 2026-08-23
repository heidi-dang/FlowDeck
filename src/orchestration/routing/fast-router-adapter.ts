/**
 * Adapter between HeidiFastRouter decisions and FlowDeck authoritative RoutingDecision domain.
 *
 * Provides typed bi-directional mapping without `as any` casts and fails closed if evidence is malformed.
 * Uses real FlowDeck task assessment logic without fabricating risk/ambiguity, fake workstream paths, or fake model recommendations.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
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
import {
  CODE_MODE_REJECTION_REASONS,
  type CodeModeRejectionReason,
  type CodeModeTelemetry,
} from "../../services/heidi-code-mode-policy";

export const VALID_EXECUTION_CLASSES: ReadonlySet<string> = new Set<ExecutionClass>([
  "FAST_DIRECT",
  "SPECIALIST",
  "PARALLEL_SPECIALISTS",
  "STANDARD",
  "DEEP",
]);

export const VALID_SPECIALIST_DOMAINS: ReadonlySet<string> = new Set<SpecialistDomain>([
  "DEBUG",
  "SECURITY",
  "UI",
  "BACKEND",
  "DEVOPS",
  "RELEASE",
  "REVIEW",
  "ARCHITECTURE",
]);

/** Standard FlowDeck model recommendation constant: preserves user/global configured model. */
export const PRESERVE_CONFIGURED_MODEL = "advisory-only: preserve configured model";

/** Compatibility sentinel SHA when running outside a git repository or when commit provenance is unavailable. */
export const UNKNOWN_SOURCE_SHA = "0000000000000000000000000000000000000000";

export function isExecutionClass(val: unknown): val is ExecutionClass {
  return typeof val === "string" && VALID_EXECUTION_CLASSES.has(val);
}

export function isSpecialistDomain(val: unknown): val is SpecialistDomain {
  return typeof val === "string" && VALID_SPECIALIST_DOMAINS.has(val);
}

export const codeModeTelemetrySchema = z.object({
  codeModeConsidered: z.boolean(),
  codeModeSelected: z.boolean(),
  codeModeRejectedReason: z.enum(CODE_MODE_REJECTION_REASONS).optional(),
  estimatedToolCalls: z.number().int().nonnegative().optional(),
  estimatedParallelWidth: z.number().int().nonnegative().optional(),
  estimatedDependencyStages: z.number().int().nonnegative().optional(),
  actualToolCalls: z.number().int().nonnegative().optional(),
  actualDurationMs: z.number().nonnegative().optional(),
  actualResultBytes: z.number().int().nonnegative().optional(),
  terminalStatus: z.enum(["success", "error", "timeout"]).optional(),
}).strict();

export function isCodeModeTelemetry(val: unknown): val is CodeModeTelemetry {
  return codeModeTelemetrySchema.safeParse(val).success;
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
      // Non-git directory or git error -> use explicit UNKNOWN_SOURCE_SHA sentinel
    }
  }
  return UNKNOWN_SOURCE_SHA;
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
    { id: `ev-forced-signal-${randomUUID().slice(0, 8)}`, kind: "classification", signal: "forcedByExplicitSignal", value: String(Boolean(input.decision.forcedByExplicitSignal)), weight: 100 },
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
    routingMode: "recommendation" as const,
    strategy: mapExecutionClassToStrategy(input.decision.executionClass),
    delegate: input.decision.executionClass === "SPECIALIST" || input.decision.executionClass === "PARALLEL_SPECIALISTS",
    delegations: [], // No synthetic wildcard ownership invented
    workstreams: [], // No synthetic workstream paths invented
    budgetRecommendation,
    modelRecommendation: PRESERVE_CONFIGURED_MODEL,
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
    return null;
  }

  const goal = evMap.get("goal");
  if (!goal || typeof goal !== "string") {
    return null;
  }

  const lastUserMessageHash = evMap.get("lastUserMessageHash");
  if (!lastUserMessageHash || typeof lastUserMessageHash !== "string") {
    return null;
  }

  const reasonCode = evMap.get("reasonCode");
  if (!reasonCode || typeof reasonCode !== "string") {
    return null;
  }

  const confidenceStr = evMap.get("confidence");
  const confidence = confidenceStr !== undefined ? Number(confidenceStr) : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  const forcedByExplicitSignalRaw = evMap.get("forcedByExplicitSignal");
  if (forcedByExplicitSignalRaw !== "true" && forcedByExplicitSignalRaw !== "false") {
    return null;
  }
  const forcedByExplicitSignal = forcedByExplicitSignalRaw === "true";

  let specialists: SpecialistDomain[] | undefined;
  if (evMap.has("specialists")) {
    try {
      const parsed = JSON.parse(evMap.get("specialists")!);
      if (!Array.isArray(parsed) || !parsed.every(isSpecialistDomain)) {
        return null;
      }
      specialists = parsed;
    } catch {
      return null;
    }
  }

  let suggestedAgents: string[] | undefined;
  if (evMap.has("suggestedAgents")) {
    try {
      const parsed = JSON.parse(evMap.get("suggestedAgents")!);
      if (!Array.isArray(parsed) || !parsed.every(s => typeof s === "string" && s.length > 0)) {
        return null;
      }
      suggestedAgents = parsed;
    } catch {
      return null;
    }
  }

  let codeModeTelemetry: CodeModeTelemetry | undefined;
  if (evMap.has("telemetry")) {
    try {
      const parsed = JSON.parse(evMap.get("telemetry")!);
      if (!isCodeModeTelemetry(parsed)) {
        return null;
      }
      codeModeTelemetry = parsed;
    } catch {
      return null;
    }
  }

  let codeModeRejectedReason: CodeModeRejectionReason | undefined;
  if (evMap.has("rejected_reason")) {
    const rawReason = evMap.get("rejected_reason")!;
    if (!CODE_MODE_REJECTION_REASONS.includes(rawReason as CodeModeRejectionReason)) {
      return null;
    }
    codeModeRejectedReason = rawReason as CodeModeRejectionReason;
  }

  const routerDecision: RouterDecision = {
    executionClass: executionClassRaw,
    reason: decision.rationale[0] || "Restored from authoritative routing decision",
    reasonCode,
    confidence,
    forcedByExplicitSignal,
    specialists,
    suggestedAgents,
    codeModeTelemetry,
    codeModeRejectedReason,
  };

  return { decision: routerDecision, goal, lastUserMessageHash };
}
