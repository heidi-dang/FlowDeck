import { existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { atomicWriteFile, readJsonFile, getProjectStoreDir } from "./harness-store";
import { HarnessReportSchema, type HarnessReport } from "../contracts/report";

export function saveReport(projectId: string, report: HarnessReport): void {
  const parsed = HarnessReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`Report validation failed: ${parsed.error.message}`);
  }
  // Sanitise the generatedAt timestamp for safe use as a filename:
  // colons (:) are reserved on Windows and cause ENOENT through WSL2 interop.
  const safeName = report.generatedAt.replace(/[:]/g, "-");
  const filePath = join(getProjectStoreDir(projectId), "reports", `${safeName}.json`);
  // Ensure the reports directory exists before writing (belt-and-suspenders
  // alongside the dir creation inside atomicWriteFile).
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFile(filePath, report);
}

export function loadReport(projectId: string, reportId: string): HarnessReport | null {
  const dir = getProjectStoreDir(projectId);
  const filePath = join(dir, "reports", `${reportId}.json`);
  const data = readJsonFile<HarnessReport>(filePath);
  if (!data) return null;
  const parsed = HarnessReportSchema.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data;
}

export function listReports(projectId: string): string[] {
  
  const dir = join(getProjectStoreDir(projectId), "reports");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f: string) => f.endsWith(".json")).map((f: string) => f.replace(".json", ""));
  } catch {
    return [];
  }
}
