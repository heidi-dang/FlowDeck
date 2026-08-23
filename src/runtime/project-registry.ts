/**
 * ProjectRuntimeRegistry — project-scoped lifecycle registry for FlowDeck orchestration runtimes.
 *
 * Ensures:
 * - 1:1 binding between canonical project path and ProductionOrchestrationRuntime
 * - Thread-safe idempotent creation and disposal
 * - Clean shutdown of background outbox workers and SQLite database handles
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
  disposed: boolean;
}

const _registry = new Map<string, ProjectRuntimeContext>();

/**
 * Get or create the production orchestration runtime for a given project directory.
 */
export function getOrCreateProjectRuntime(directory: string): ProjectRuntimeContext {
  const canonicalDir = resolve(directory);
  const existing = _registry.get(canonicalDir);
  if (existing && !existing.disposed) {
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
    disposed: false,
  };

  _registry.set(canonicalDir, context);
  return context;
}

/**
 * Get the active project runtime context if it exists.
 */
export function getProjectRuntime(directory: string): ProjectRuntimeContext | null {
  const canonicalDir = resolve(directory);
  const context = _registry.get(canonicalDir);
  if (!context || context.disposed) return null;
  return context;
}

/**
 * Dispose of the project runtime and release all resources (SQLite handles, outbox workers).
 */
export async function disposeProjectRuntime(directory: string): Promise<void> {
  const canonicalDir = resolve(directory);
  const context = _registry.get(canonicalDir);
  if (!context || context.disposed) return;

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
 * Test helper: clear all project runtimes completely.
 */
export async function _resetAllProjectRuntimes(): Promise<void> {
  const keys = [..._registry.keys()];
  for (const key of keys) {
    await disposeProjectRuntime(key);
  }
}
