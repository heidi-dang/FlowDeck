/**
 * ProjectRuntimeRegistry — project-scoped lifecycle registry for FlowDeck orchestration runtimes.
 *
 * Ensures:
 * - 1:1 binding between canonical project path and ProductionOrchestrationRuntime
 * - Reference-counted owner model: multiple plugin instances/acquisitions for the same project share one runtime
 * - Clean shutdown of background outbox workers and SQLite database handles only when last owner releases
 * - Isolation between multiple concurrent or sequential project contexts
 */

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { initializeDatabase, closeConnection } from "../orchestration/persistence";
import { createProductionOrchestrationRuntime, type ProductionOrchestrationRuntime } from "../orchestration/composition";
import { FlowDeckLifecycleAdapter } from "./flowdeck-opencode-adapter";

export interface ProjectRuntimeContext {
  projectDir: string;
  dbPath: string;
  runtime: ProductionOrchestrationRuntime;
  adapter: FlowDeckLifecycleAdapter;
  refCount: number;
  disposed: boolean;
}

const _registry = new Map<string, ProjectRuntimeContext>();

/**
 * Acquire the production orchestration runtime for a given project directory.
 * Increments reference count for safe multi-owner lifecycle.
 */
export function acquireProjectRuntime(directory: string): ProjectRuntimeContext {
  const canonicalDir = resolve(directory);
  const existing = _registry.get(canonicalDir);
  if (existing && !existing.disposed) {
    existing.refCount += 1;
    return existing;
  }

  const dotFlowDeck = join(canonicalDir, ".flowdeck");
  try {
    mkdirSync(dotFlowDeck, { recursive: true });
  } catch {
    // Ignore if already exists
  }

  const dbPath = join(dotFlowDeck, "flowdeck.db");
  const initResult = initializeDatabase({ path: dbPath });
  const runtime = createProductionOrchestrationRuntime(initResult.db);
  const adapter = new FlowDeckLifecycleAdapter(canonicalDir, runtime);

  const context: ProjectRuntimeContext = {
    projectDir: canonicalDir,
    dbPath,
    runtime,
    adapter,
    refCount: 1,
    disposed: false,
  };

  _registry.set(canonicalDir, context);
  return context;
}

/**
 * Release an acquired project runtime. Disposes database and workers only when refCount reaches 0.
 */
export async function releaseProjectRuntime(directory: string): Promise<void> {
  const canonicalDir = resolve(directory);
  const context = _registry.get(canonicalDir);
  if (!context || context.disposed) return;

  context.refCount -= 1;
  if (context.refCount > 0) {
    return; // Other owners still active
  }

  context.disposed = true;
  _registry.delete(canonicalDir);

  // Stop outbox worker if active
  if (context.runtime.outboxWorker && typeof context.runtime.outboxWorker.stop === "function") {
    try {
      context.runtime.outboxWorker.stop();
    } catch {
      // Ignore teardown error
    }
  }

  // Dispose adapter
  try {
    context.adapter.dispose();
  } catch {
    // Ignore teardown error
  }

  // Close database connection
  try {
    closeConnection(context.dbPath);
  } catch {
    // Ignore teardown error
  }
}

/**
 * Get the active project runtime context if it exists. Strictly read-only: does NOT acquire lease or increment refCount.
 */
export function getProjectRuntime(directory: string): ProjectRuntimeContext | null {
  const canonicalDir = resolve(directory);
  const context = _registry.get(canonicalDir);
  if (!context || context.disposed) return null;
  return context;
}

/**
 * @deprecated Use explicit acquireProjectRuntime(directory) to acquire ownership or getProjectRuntime(directory) for read-only access.
 */
export function getOrCreateProjectRuntime(directory: string): ProjectRuntimeContext {
  return acquireProjectRuntime(directory);
}

/**
 * Force disposal of project runtime regardless of refCount (for test isolation/admin teardown).
 */
export async function disposeProjectRuntime(directory: string): Promise<void> {
  const canonicalDir = resolve(directory);
  const context = _registry.get(canonicalDir);
  if (!context) return;
  context.refCount = 1;
  await releaseProjectRuntime(directory);
}

/**
 * Test helper: clear all project runtimes completely.
 */
export async function _resetAllProjectRuntimes(): Promise<void> {
  const keys = [..._registry.keys()];
  for (const key of keys) {
    await disposeProjectRuntime(key);
  }
}
