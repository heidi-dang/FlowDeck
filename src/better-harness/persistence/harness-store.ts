import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/**
 * Module-level state directory override.
 * When set, all persistence goes to this directory instead of ~/.flowdeck/state/.
 *
 * @deprecated The global override is legacy. The standalone runtime and
 * launcher pass an explicit per-instance `stateDir` through the persistence
 * functions (see `getProjectStoreDir(projectId, stateDir?)`) so that one
 * instance can never redirect another instance's stores. The global override
 * is retained only for backwards compatibility with callers that never used
 * instance scoping; it must not be called by the runtime path.
 */
let _stateDirOverride: string | null = null;

/**
 * @deprecated Use per-instance `stateDir` arguments instead. See
 * `getProjectStoreDir(projectId, stateDir?)`. Setting this global redirects
 * ALL better-harness persistence in the process and can corrupt concurrent
 * instances; it must not be used by the standalone runtime.
 */
export function setFlowDeckStateDir(dir: string): void {
  _stateDirOverride = dir;
}

/**
 * @deprecated Retained for backwards compatibility.
 */
export function resetFlowDeckStateDir(): void {
  _stateDirOverride = null;
}

export function getFlowDeckStateDir(): string {
  return _stateDirOverride ?? join(homedir(), ".flowdeck", "state");
}

/**
 * Resolve the per-project store directory.
 *
 * @param projectId harness project identifier
 * @param stateDir optional instance-scoped state directory. When provided,
 *   persistence is confined to `stateDir` and the global override is ignored.
 *   The standalone runtime always passes its instance state directory so
 *   concurrent instances remain isolated.
 */
export function getProjectStoreDir(projectId: string, stateDir?: string): string {
  return join(stateDir ?? getFlowDeckStateDir(), projectId, "better-harness");
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
