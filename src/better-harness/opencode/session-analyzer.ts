import type { SessionRecord } from "./session-reader";

export interface SessionAnalysis {
  totalSessions: number;
  longSessions: number;
  failedSessions: number;
  repeatedFailures: number;
  permissionInterruptions: number;
  compactions: number;
  delegationLoops: number;
  toolCallBudgetExhaustions: number;
  averageDurationMs: number;
  patterns: string[];
}

export function analyzeSessions(records: SessionRecord[]): SessionAnalysis {
  let longSessions = 0;
  let failedSessions = 0;
  let permissionInterruptions = 0;
  let compactions = 0;
  let delegationLoops = 0;
  let toolCallBudgetExhaustions = 0;
  let totalDurationMs = 0;
  let durationCount = 0;
  const patterns: string[] = [];

  for (const record of records) {
    if (record.durationMs && record.durationMs > 300_000) {
      longSessions++;
      patterns.push(`Long session: ${record.id} (${Math.round(record.durationMs / 1000)}s)`);
    }

    if (record.status === "failed") {
      failedSessions++;
      patterns.push(`Failed session: ${record.id} with ${record.errors.length} errors`);
    }

    if (record.durationMs) {
      totalDurationMs += record.durationMs;
      durationCount++;
    }

    for (const event of record.events) {
      if (event.type === "permission_interrupted" || event.type === "permission.block") {
        permissionInterruptions++;
      }
      if (event.type === "compaction") {
        compactions++;
      }
      if (event.type === "delegation" && event.data?.loop_detected) {
        delegationLoops++;
      }
      if (event.type.includes("budget_exceeded") || event.type.includes("tool_call_budget")) {
        toolCallBudgetExhaustions++;
      }
    }
  }

  // Detect repeated failures pattern
  if (failedSessions > 0 && records.length > 2 && failedSessions / records.length > 0.3) {
    patterns.push(`High failure rate: ${failedSessions}/${records.length} sessions failed`);
  }

  return {
    totalSessions: records.length,
    longSessions,
    failedSessions,
    repeatedFailures: records.filter((r) => r.errors.length > 2).length,
    permissionInterruptions,
    compactions,
    delegationLoops,
    toolCallBudgetExhaustions,
    averageDurationMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0,
    patterns,
  };
}
