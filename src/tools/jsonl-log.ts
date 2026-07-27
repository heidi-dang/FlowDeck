import { readFileSync, existsSync, writeFileSync, statSync, renameSync } from "fs";
import { appendWithLock } from "./planning-state-lib";

const MAX_RECORD_SIZE = 1024 * 1024; // 1MB
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export async function appendJsonlWithRotation(path: string, record: any): Promise<{success: boolean; error?: string}> {
  const line = JSON.stringify(record) + "\n";
  if (line.length > MAX_RECORD_SIZE) {
    return { success: false, error: "Record size limit exceeded" };
  }

  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size + line.length > MAX_FILE_SIZE) {
      const rotatedPath = `${path}.${Date.now()}`;
      try {
        renameSync(path, rotatedPath);

        // Retention: keep at most 5 rotated files
        const { readdirSync, unlinkSync } = require("fs");
        const { dirname, basename, join } = require("path");
        const dir = dirname(path);
        const base = basename(path);
        const rotatedFiles = readdirSync(dir)
          .filter((f: string) => f.startsWith(base + "."))
          .map((f: string) => ({ name: f, fullPath: join(dir, f), time: Number(f.split(".").pop()) || 0 }))
          .sort((a: any, b: any) => b.time - a.time);

        if (rotatedFiles.length > 5) {
          for (let i = 5; i < rotatedFiles.length; i++) {
            unlinkSync(rotatedFiles[i].fullPath);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  await appendWithLock(path, line);
  return { success: true };
}

export function readJsonlQuarantine(path: string): { records: any[] } {
  if (!existsSync(path)) return { records: [] };

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const records = [];
  const corruptLines = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      corruptLines.push(line);
    }
  }

  if (corruptLines.length > 0) {
    const qPath = `${path}.quarantine.${Date.now()}`;
    writeFileSync(qPath, corruptLines.join("\n") + "\n", "utf-8");
    writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8");
  }

  return { records };
}
