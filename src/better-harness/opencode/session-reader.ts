import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface SessionRecord {
  id: string;
  startTime: string;
  endTime?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  toolCalls: number;
  errors: string[];
  events: SessionEvent[];
  durationMs?: number;
}

export interface SessionEvent {
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export function readSessionRecords(root: string): SessionRecord[] {
  const records: SessionRecord[] = [];

  const sessionDirs = [
    join(root, ".opencode", "sessions"),
    join(root, ".opencode"),
  ];

  for (const dir of sessionDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".log"))
        .map((f) => join(dir, f));

      for (const file of files) {
        try {
          const content = readFileSync(file, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim());

          const events: SessionEvent[] = [];
          const errors: string[] = [];
          let sessionId = file.split(/[\\/]/).pop() ?? "unknown";
          let startTime = "";
          let endTime: string | undefined;
          let toolCalls = 0;

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const ts = entry.timestamp ?? entry.time ?? "";
              if (!startTime) startTime = ts;

              if (entry.type === "tool_call" || entry.kind === "tool.execute.before") toolCalls++;

              if (entry.level === "error" || entry.status === "error") {
                errors.push(entry.message ?? entry.error ?? JSON.stringify(entry));
              }

              events.push({
                type: entry.type ?? entry.kind ?? "unknown",
                timestamp: ts,
                data: entry,
              });

              if (entry.type === "session.completed" || entry.type === "session.error") {
                endTime = ts;
              }
            } catch { /* skip malformed line */ }
          }

          const durationMs = startTime && endTime
            ? new Date(endTime).getTime() - new Date(startTime).getTime()
            : undefined;

          records.push({
            id: sessionId,
            startTime,
            endTime,
            status: errors.length > 0 ? "failed" : endTime ? "completed" : "running",
            toolCalls,
            errors,
            events,
            durationMs,
          });
        } catch { /* skip */ }
      }
      if (records.length > 0) break;
    } catch { /* try next dir */ }
  }

  return records;
}
