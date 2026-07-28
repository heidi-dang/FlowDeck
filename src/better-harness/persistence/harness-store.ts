import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/**
 * Module-level state directory override.
 * When set, all persistence goes to this directory instead of ~/.flowdeck/state/.
 * Used by standalone launcher to guarantee isolation from real state.
 */
let _stateDirOverride: string | null = null;

/**
 * Override the default state directory (for standalone/testing isolation).
 * All subsequent persistence calls will use `dir` instead of ~/.flowdeck/state/.
 */
export function setFlowDeckStateDir(dir: string): void {
  _stateDirOverride = dir;
}

/**
 * Reset the state directory back to the default (~/.flowdeck/state/).
 */
export function resetFlowDeckStateDir(): void {
  _stateDirOverride = null;
}

export function getFlowDeckStateDir(): string {
  return _stateDirOverride ?? join(homedir(), ".flowdeck", "state");
}

export function getProjectStoreDir(projectId: string): string {
  return join(getFlowDeckStateDir(), projectId, "better-harness");
}

export function atomicWriteFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    // Quarantine corrupt records
    const quarantinePath = filePath + ".quarantine";
    try {
      renameSync(filePath, quarantinePath);
    } catch { /* ignore quarantine failure */ }
    return null;
  }
}
