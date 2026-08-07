import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { atomicWriteFile, readJsonFile, getProjectStoreDir } from "./harness-store";
import { HarnessRunStatusEnum } from "../contracts/common";
import type { HarnessRunStatus } from "../contracts/common";

export interface StoredRun {
  runId: string;
  projectId: string;
  status: HarnessRunStatus;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  stage?: string;
  progressPercent?: number;
}

export function saveRun(projectId: string, run: StoredRun, stateDir?: string): void {
  const parsed = HarnessRunStatusEnum.safeParse(run.status);
  if (!parsed.success) {
    throw new Error(`Invalid run status: ${run.status}`);
  }
  const dir = getProjectStoreDir(projectId, stateDir);
  const filePath = join(dir, "runs", `${run.runId}.json`);
  atomicWriteFile(filePath, run);
}

export function loadRun(projectId: string, runId: string, stateDir?: string): StoredRun | null {
  const dir = getProjectStoreDir(projectId, stateDir);
  const filePath = join(dir, "runs", `${runId}.json`);
  return readJsonFile<StoredRun>(filePath);
}

export function listRuns(projectId: string, stateDir?: string): string[] {
  
  const dir = join(getProjectStoreDir(projectId, stateDir), "runs");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f: string) => f.endsWith(".json")).map((f: string) => f.replace(".json", ""));
  } catch {
    return [];
  }
}
