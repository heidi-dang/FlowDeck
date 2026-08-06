import { join } from "path";
import { atomicWriteFile, readJsonFile, getProjectStoreDir } from "./harness-store";
import type { HarnessFinding } from "../contracts/report";

export interface FindingIndex {
  version: number;
  projectId: string;
  findings: HarnessFinding[];
  updatedAt: string;
}

export function saveFindingIndex(projectId: string, findings: HarnessFinding[], stateDir?: string): void {
  const index: FindingIndex = {
    version: 1,
    projectId,
    findings,
    updatedAt: new Date().toISOString(),
  };
  const filePath = join(getProjectStoreDir(projectId, stateDir), "findings.json");
  atomicWriteFile(filePath, index);
}

export function loadFindingIndex(projectId: string, stateDir?: string): FindingIndex | null {
  const filePath = join(getProjectStoreDir(projectId, stateDir), "findings.json");
  return readJsonFile<FindingIndex>(filePath);
}

export function getActiveFindings(projectId: string, stateDir?: string): HarnessFinding[] {
  const index = loadFindingIndex(projectId, stateDir);
  if (!index) return [];
  return index.findings.filter((f) => f.status !== "fixed" && f.status !== "ignored");
}
