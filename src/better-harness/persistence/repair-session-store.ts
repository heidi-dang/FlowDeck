import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { atomicWriteFile, readJsonFile, getProjectStoreDir } from "./harness-store";

export interface StoredRepairSession {
  repairSessionId: string;
  findingId: string;
  prompt: string;
  status: "created" | "in-progress" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  result?: {
    fixed: boolean;
    changes: string[];
    validationPassed: boolean;
  };
}

export function saveRepairSession(projectId: string, session: StoredRepairSession, stateDir?: string): void {
  const filePath = join(getProjectStoreDir(projectId, stateDir), "repair-sessions", `${session.repairSessionId}.json`);
  atomicWriteFile(filePath, session);
}

export function loadRepairSession(projectId: string, repairSessionId: string, stateDir?: string): StoredRepairSession | null {
  const dir = getProjectStoreDir(projectId, stateDir);
  const filePath = join(dir, "repair-sessions", `${repairSessionId}.json`);
  return readJsonFile<StoredRepairSession>(filePath);
}

export function listRepairSessions(projectId: string, stateDir?: string): string[] {
  
  const dir = join(getProjectStoreDir(projectId, stateDir), "repair-sessions");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f: string) => f.endsWith(".json")).map((f: string) => f.replace(".json", ""));
  } catch {
    return [];
  }
}
