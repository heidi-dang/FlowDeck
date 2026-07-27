import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { HarnessEvidence } from "../contracts/report";
import { normalizeEvidence, type RawCollectorEvidence } from "../evidence/evidence-normalizer";

export function collectSessionEvidence(root: string): HarnessEvidence[] {
  const raw: RawCollectorEvidence[] = [];

  // Try .opencode/sessions/ first, then fallback to .opencode/audit or flowdeck.log
  const sessionDirs = [
    join(root, ".opencode", "sessions"),
    join(root, ".opencode"),
  ];

  let sessionFiles: string[] = [];

  for (const dir of sessionDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        sessionFiles = entries
          .filter((f) => f.endsWith(".json") || f.endsWith(".log"))
          .map((f) => join(dir, f));
        if (sessionFiles.length > 0) break;
      } catch { /* try next */ }
    }
  }

  if (sessionFiles.length === 0) {
    raw.push({
      category: "session",
      source: ".opencode/",
      summary: "No session records found",
      path: root,
      confidence: 0.5,
    });
    return normalizeEvidence(raw);
  }

  // Analyze session files
  let totalSessions = 0;
  let longSessions = 0;
  let failedSessions = 0;
  let repeatedFailures = 0;
  let compactions = 0;
  let permissionInterruptions = 0;

  for (const file of sessionFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      for (const line of lines.slice(-200)) {
        try {
          const entry = JSON.parse(line);
          totalSessions++;

          if (entry.type === "session" || entry.kind === "session") {
            const duration = entry.duration_ms ?? entry.duration ?? 0;
            if (duration > 300_000) longSessions++; // >5min

            if (entry.status === "failed" || entry.error) failedSessions++;
            if (entry.compacted || entry.type === "compaction") compactions++;
            if (entry.type === "permission_interrupted" || entry.kind === "permission.block") permissionInterruptions++;
          }

          // Track tool-level failures
          if (entry.level === "error" || entry.status === "error") {
            repeatedFailures++;
          }
        } catch { /* skip malformed */ }
      }

      raw.push({
        category: "session",
        source: file,
        summary: `Session file: ${lines.length} entries`,
        path: file,
        confidence: 0.9,
      });
    } catch { /* skip unreadable */ }
  }

  // Summary metrics
  if (totalSessions > 0) {
    if (longSessions > 0) {
      raw.push({
        category: "session",
        source: "session-analysis",
        summary: `${longSessions}/${totalSessions} sessions exceed 5 minutes`,
        confidence: 0.8,
      });
    }

    if (failedSessions > 0) {
      raw.push({
        category: "session",
        source: "session-analysis",
        summary: `${failedSessions} failed sessions detected`,
        confidence: 0.8,
      });
    }

    if (permissionInterruptions > 0) {
      raw.push({
        category: "session",
        source: "session-analysis",
        summary: `${permissionInterruptions} permission interruptions detected`,
        confidence: 0.8,
      });
    }

    if (compactions > 0) {
      raw.push({
        category: "session",
        source: "session-analysis",
        summary: `${compactions} session compactions detected`,
        confidence: 0.8,
      });
    }
  }

  return normalizeEvidence(raw);
}

export const sessionCollector = {
  name: "sessions" as const,
  collect: collectSessionEvidence,
};
