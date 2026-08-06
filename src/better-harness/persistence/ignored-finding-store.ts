import { join } from "path";
import { atomicWriteFile, readJsonFile, getProjectStoreDir } from "./harness-store";

export interface IgnoredFinding {
  findingId: string;
  reason: string;
  actor: string;
  timestamp: string;
}

export interface IgnoredFindingsIndex {
  version: number;
  projectId: string;
  ignored: IgnoredFinding[];
  updatedAt: string;
}

export function saveIgnoredFinding(projectId: string, entry: IgnoredFinding, stateDir?: string): void {
  const filePath = join(getProjectStoreDir(projectId, stateDir), "ignored-findings.json");
  const existing = readJsonFile<IgnoredFindingsIndex>(filePath) ?? {
    version: 1,
    projectId,
    ignored: [],
    updatedAt: "",
  };
  existing.ignored.push(entry);
  existing.updatedAt = new Date().toISOString();
  atomicWriteFile(filePath, existing);
}

export function loadIgnoredFindings(projectId: string, stateDir?: string): IgnoredFinding[] {
  const filePath = join(getProjectStoreDir(projectId, stateDir), "ignored-findings.json");
  const data = readJsonFile<IgnoredFindingsIndex>(filePath);
  return data?.ignored ?? [];
}

export function isFindingIgnored(projectId: string, findingId: string, stateDir?: string): boolean {
  const ignored = loadIgnoredFindings(projectId, stateDir);
  return ignored.some((i) => i.findingId === findingId);
}
