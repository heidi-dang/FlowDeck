import type {
  SelfHostReport,
  Identity,
  Orchestration,
  SpecialistTokenMetrics,
  ToolMetrics,
  PerformanceMetrics,
  StabilityMetrics,
  Comparison,
  FinalVerdict,
} from "./self-host-report-schema.js";
import { validateSelfHostReport, SCHEMA_VERSION } from "./self-host-report-schema.js";

// ── JSON Renderer ─────────────────────────────────────────────────────────────

export function renderReportToJson(report: SelfHostReport): string {
  const validated = validateSelfHostReport(report);
  return JSON.stringify(validated, null, 2);
}

export function renderReportToJsonFile(
  report: SelfHostReport,
  filePath: string,
): void {
  const fs = require("fs") as typeof import("fs");
  fs.writeFileSync(filePath, renderReportToJson(report), "utf-8");
}

// ── Markdown Renderer ────────────────────────────────────────────────────────

function renderIdentity(identity: Identity | undefined): string {
  if (!identity) return "| _No identity data_ |\n";

  const rows = [
    ["Developer", identity.developer ?? "_unknown_"],
    ["Task ID", identity.taskId ?? "_none_"],
    ["Phase", identity.phase ?? "_none_"],
    ["Campaign ID", identity.campaignId ?? "_none_"],
    ["Main Session ID", identity.mainSessionId ?? "_none_"],
    ["Child Session IDs", identity.childSessionIds?.join(", ") ?? "_none_"],
    ["Branch", identity.branch ?? "_none_"],
    ["Base SHA", identity.baseSha ?? "_none_"],
    ["Starting SHA", identity.startingSha ?? "_none_"],
    ["Final Local SHA", identity.finalLocalSha ?? "_none_"],
    ["Final Remote SHA", identity.finalRemoteSha ?? "_none_"],
    ["PR", identity.pr ?? "_none_"],
    ["FlowDeck Harness Identity", identity.flowdeckHarnessIdentity ?? "_none_"],
    ["Candidate Identity", identity.candidateIdentity ?? "_none_"],
  ];

  return rows
    .map(([k, v]) => `| **${k}** | ${v} |`)
    .join("\n");
}

function renderStageDurations(orchestration: Orchestration | undefined): string {
  if (!orchestration?.stageDurations?.length) return "_none_";

  const lines = orchestration.stageDurations.map(
    (s) => `| ${s.stage} | ${s.startMs} | ${s.endMs ?? "_ongoing_"} | ${s.durationMs ?? "_running_"} |`,
  );
  return ["| Stage | Start (ms) | End (ms) | Duration (ms) |", ...lines].join("\n");
}

function renderOrchestration(orchestration: Orchestration | undefined): string {
  if (!orchestration) return "_No orchestration data_";

  const sections: string[] = [];

  if (orchestration.strategy) {
    sections.push(`**Strategy:** ${orchestration.strategy}`);
  }

  if (orchestration.stageOrder?.length) {
    sections.push(`**Stage order:** ${orchestration.stageOrder.join(" → ")}`);
  }

  if (orchestration.stageDurations?.length) {
    sections.push("\n**Stage durations:**\n" + renderStageDurations(orchestration));
  }

  if (orchestration.specialists?.length) {
    const specialistLines = orchestration.specialists.map(
      (s) => `- ${s.id}${s.name ? ` (${s.name})` : ""}${s.role ? ` — ${s.role}` : ""}`,
    );
    sections.push("\n**Specialists:**\n" + specialistLines.join("\n"));
  }

  if (orchestration.delegationReasons?.length) {
    const lines = orchestration.delegationReasons.map(
      (d) => `- [${d.specialistId ?? "_"}] ${d.reason} (${d.timestamp})`,
    );
    sections.push("\n**Delegation reasons:**\n" + lines.join("\n"));
  }

  if (orchestration.checkpoints?.length) {
    const lines = orchestration.checkpoints.map(
      (c) => `- ${c.name} (${c.id}) @ ${c.timestamp}`,
    );
    sections.push("\n**Checkpoints:**\n" + lines.join("\n"));
  }

  if (orchestration.decisions?.length) {
    const lines = orchestration.decisions.map(
      (d) => `- [${d.type}] ${d.rationale ?? "_no rationale_"} (${d.timestamp})`,
    );
    sections.push("\n**Decisions:**\n" + lines.join("\n"));
  }

  if (orchestration.recoveryAttempts?.length) {
    const lines = orchestration.recoveryAttempts.map(
      (r) => `- ${r.stage} #${r.attemptNumber}: ${r.success ? "✓" : "✗"} ${r.error ?? ""}`,
    );
    sections.push("\n**Recovery attempts:**\n" + lines.join("\n"));
  }

  return sections.join("\n") || "_No orchestration data_";
}

function renderTokenMetrics(tokenMetrics: SpecialistTokenMetrics | undefined): string {
  if (!tokenMetrics) return "_No token metrics_";

  const lines: string[] = [];

  if (tokenMetrics.heidi) {
    const h = tokenMetrics.heidi;
    lines.push("**Heidi (main session):**");
    lines.push(`- Provider: ${h.provider ?? "_unknown_"}`);
    if (h.inputTokens) lines.push(`- Input tokens: ${h.inputTokens.toLocaleString()}`);
    if (h.outputTokens) lines.push(`- Output tokens: ${h.outputTokens.toLocaleString()}`);
    if (h.reasoningTokens) lines.push(`- Reasoning tokens: ${h.reasoningTokens.toLocaleString()}`);
    if (h.cacheReads) lines.push(`- Cache reads: ${h.cacheReads.toLocaleString()}`);
    if (h.cacheWrites) lines.push(`- Cache writes: ${h.cacheWrites.toLocaleString()}`);
    if (h.estimatedCostUsd) lines.push(`- Estimated cost: $${h.estimatedCostUsd.toFixed(4)}`);
    if (h.compactions) lines.push(`- Compactions: ${h.compactions}`);
    if (h.duplicatedContextEstimate) lines.push(`- Duplicated context estimate: ${h.duplicatedContextEstimate}`);
  }

  if (tokenMetrics.perSpecialist?.length) {
    lines.push("\n**Per specialist:**");
    for (const s of tokenMetrics.perSpecialist) {
      lines.push(`- ${s.provider ?? "unknown"}: ${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out / $${(s.estimatedCostUsd ?? 0).toFixed(4)}`);
    }
  }

  return lines.join("\n") || "_No token metrics_";
}

function renderToolMetrics(toolMetrics: ToolMetrics | undefined): string {
  if (!toolMetrics) return "_No tool metrics_";

  const lines: string[] = [];

  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total calls | ${toolMetrics.totalCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Successful | ${toolMetrics.successfulCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Failed | ${toolMetrics.failedCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Blocked | ${toolMetrics.blockedCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Retries | ${toolMetrics.retries?.toLocaleString() ?? 0} |`);
  lines.push(`| Cancellations | ${toolMetrics.cancellations?.toLocaleString() ?? 0} |`);
  lines.push(`| Native FDX calls | ${toolMetrics.nativeFdxCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Fallback calls | ${toolMetrics.fallbackCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Cache hits | ${toolMetrics.cacheHits?.toLocaleString() ?? 0} |`);
  lines.push(`| Cache misses | ${toolMetrics.cacheMisses?.toLocaleString() ?? 0} |`);
  lines.push(`| Batched operations | ${toolMetrics.batchedOperations?.toLocaleString() ?? 0} |`);
  lines.push(`| Redundant calls | ${toolMetrics.redundantCalls?.toLocaleString() ?? 0} |`);
  lines.push(`| Duplicated queries | ${toolMetrics.duplicatedQueries?.toLocaleString() ?? 0} |`);
  lines.push(`| Output bytes | ${toolMetrics.outputBytes?.toLocaleString() ?? 0} |`);
  lines.push(`| Truncated outputs | ${toolMetrics.truncatedOutputs?.toLocaleString() ?? 0} |`);

  if (toolMetrics.slowestTools?.length) {
    lines.push("\n**Slowest tools:**");
    lines.push(`| Tool | Total Time (ms) | Calls |`);
    lines.push(`|------|-----------------|-------|`);
    for (const t of toolMetrics.slowestTools) {
      lines.push(`| ${t.toolName} | ${t.totalTimeMs.toLocaleString()} | ${t.callCount.toLocaleString()} |`);
    }
  }

  return lines.join("\n");
}

function renderPerformance(performance: PerformanceMetrics | undefined): string {
  if (!performance) return "_No performance data_";

  const rows = [
    ["Wall time", performance.wallTimeMs, "ms"],
    ["Active execution", performance.activeExecutionTimeMs, "ms"],
    ["Provider wait", performance.providerWaitTimeMs, "ms"],
    ["Tool wait", performance.toolWaitTimeMs, "ms"],
    ["Verification", performance.verificationTimeMs, "ms"],
    ["CI wait", performance.ciWaitTimeMs, "ms"],
    ["Time to first useful action", performance.timeToFirstUsefulActionMs, "ms"],
    ["Specialist startup latency", performance.specialistStartupLatencyMs, "ms"],
    ["Parallelism factor", performance.parallelismFactor, "x"],
    ["Delegation benefit", performance.delegationBenefitMs, "ms"],
    ["Delegation overhead", performance.delegationOverheadMs, "ms"],
    ["Context construction latency", performance.contextConstructionLatencyMs, "ms"],
    ["Completion gate latency", performance.completionGateLatencyMs, "ms"],
  ];

  return rows
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v, u]) => `| **${k}** | ${Number(v).toLocaleString()} ${u} |`)
    .join("\n");
}

function renderStability(stability: StabilityMetrics | undefined): string {
  if (!stability) return "_No stability data_";

  const rows = [
    ["Crashes", stability.crashes],
    ["Unhandled errors", stability.unhandledErrors],
    ["Timeouts", stability.timeouts],
    ["Hangs", stability.hangs],
    ["Orphaned specialists", stability.orphanedSpecialists],
    ["Duplicate child correlation", stability.duplicateChildCorrelation],
    ["Missing child correlation", stability.missingChildCorrelation],
    ["Missed checkpoints", stability.missedCheckpoints],
    ["Failed checkpoint writes", stability.failedCheckpointWrites],
    ["Stale state events", stability.staleStateEvents],
    ["Stale verification events", stability.staleVerificationEvents],
    ["Repeated identical failed commands", stability.repeatedIdenticalFailedCommands],
    ["Leaked locks", stability.leakedLocks],
    ["Unintended file changes", stability.unintendedFileChanges],
    ["Cleanup failures", stability.cleanupFailures],
    ["Dirty tree contamination", stability.dirtyTreeContamination],
    ["Unresolved guard failures", stability.unresolvedGuardFailures],
    ["Cancellation/recovery failures", stability.cancellationRecoveryFailures],
  ];

  return rows
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `| **${k}** | ${v} |`)
    .join("\n");
}

function renderComparison(comparison: Comparison | undefined): string {
  if (!comparison) return "_No comparison data_";
  const sections: string[] = [];

  if (comparison.vsFrozenV103Baseline) {
    const b = comparison.vsFrozenV103Baseline;
    sections.push("**vs frozen v1.0.3 baseline:**");
    const rows = [
      ["Wall time delta", b.wallTimeDeltaMs, "ms"],
      ["Token delta", b.tokenDelta],
      ["Cost delta (USD)", b.costDeltaUsd],
      ["Stability incidents", b.stabilityIncidents],
    ];
    sections.push(
      rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v, u]) => `| ${k} | ${v}${u ? " " + u : ""} |`)
        .join("\n"),
    );
  }

  if (comparison.vsPreviousComparableTask) {
    const p = comparison.vsPreviousComparableTask;
    sections.push(`\n**vs previous comparable task (${p.taskId ?? "_"}):**`);
    const rows = [
      ["Wall time delta", p.wallTimeDeltaMs, "ms"],
      ["Token delta", p.tokenDelta],
      ["Cost delta (USD)", p.costDeltaUsd],
    ];
    sections.push(
      rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v, u]) => `| ${k} | ${v}${u ? " " + u : ""} |`)
        .join("\n"),
    );
  }

  if (comparison.vsMilestoneTarget) {
    const m = comparison.vsMilestoneTarget;
    sections.push("\n**vs milestone target:**");
    const rows = [
      ["Target wall time", m.targetWallTimeMs, "ms"],
      ["Target cost (USD)", m.targetCostUsd],
      ["Target token budget", m.targetTokenBudget],
      ["Achieved", m.achieved ? "✓" : "✗"],
    ];
    sections.push(
      rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `| ${k} | ${v} |`)
        .join("\n"),
    );
  }

  if (comparison.vsCandidateBuild) {
    const c = comparison.vsCandidateBuild;
    sections.push(`\n**vs candidate build (${c.candidateSha ?? "_"}):**`);
    const rows = [
      ["Wall time delta", c.wallTimeDeltaMs, "ms"],
      ["Token delta", c.tokenDelta],
      ["Cost delta (USD)", c.costDeltaUsd],
    ];
    sections.push(
      rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v, u]) => `| ${k} | ${v}${u ? " " + u : ""} |`)
        .join("\n"),
    );
  }

  return sections.join("\n") || "_No comparison data_";
}

function renderVerdict(verdict: FinalVerdict | undefined): string {
  if (!verdict) return "_No final verdict_";

  const lines: string[] = [];

  if (verdict.implementationReadiness) {
    lines.push(`**Implementation readiness:** ${verdict.implementationReadiness}/5`);
  }
  if (verdict.executionQuality) {
    lines.push(`**Execution quality:** ${verdict.executionQuality}/5`);
  }
  if (verdict.performanceRating) {
    lines.push(`**Performance:** ${verdict.performanceRating}/5`);
  }
  if (verdict.stabilityRating) {
    lines.push(`**Stability:** ${verdict.stabilityRating}/5`);
  }
  if (verdict.overallPass !== undefined) {
    lines.push(`**Overall pass:** ${verdict.overallPass ? "✓ YES" : "✗ NO"}`);
  }
  if (verdict.summary) {
    lines.push(`\n${verdict.summary}`);
  }
  if (verdict.recommendations?.length) {
    lines.push("\n**Recommendations:**");
    for (const r of verdict.recommendations) {
      lines.push(`- ${r}`);
    }
  }

  return lines.join("\n") || "_No final verdict_";
}

/**
 * Renders a SelfHostReport to Markdown format.
 * The Markdown is generated from validated JSON data.
 */
export function renderReportToMarkdown(report: SelfHostReport): string {
  const validated = validateSelfHostReport(report);

  const sections: string[] = [
    `# FlowDeck Self-Host Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Schema version | ${validated.schemaVersion} |`,
    `| Generated at | ${validated.generatedAt} |`,
    ``,
    `## Identity`,
    ``,
    renderIdentity(validated.identity),
    ``,
    `## Orchestration`,
    ``,
    renderOrchestration(validated.orchestration),
    ``,
    `## Token / Model Metrics`,
    ``,
    renderTokenMetrics(validated.tokenMetrics),
    ``,
    `## Tool Metrics`,
    ``,
    renderToolMetrics(validated.toolMetrics),
    ``,
    `## Performance`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    renderPerformance(validated.performance),
    ``,
    `## Stability`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    renderStability(validated.stability),
    ``,
    `## Comparison`,
    ``,
    renderComparison(validated.comparison),
    ``,
    `## Final Verdict`,
    ``,
    renderVerdict(validated.finalVerdict),
  ];

  return sections.join("\n");
}

export function renderReportToMarkdownFile(
  report: SelfHostReport,
  filePath: string,
): void {
  const fs = require("fs") as typeof import("fs");
  fs.writeFileSync(filePath, renderReportToMarkdown(report), "utf-8");
}
