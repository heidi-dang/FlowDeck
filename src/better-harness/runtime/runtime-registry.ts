import { customizationCollector } from "../collectors/customization-collector";
import { foundationCollector } from "../collectors/foundation-collector";
import { sessionCollector } from "../collectors/session-collector";
import { analyzeTaskUnderstanding } from "../analyzers/task-understanding";
import { analyzeControlledExecution } from "../analyzers/controlled-execution";
import { analyzeChangeValidation } from "../analyzers/change-validation";
import { analyzeReliableDelivery } from "../analyzers/reliable-delivery";
import { analyzeLearningCapture } from "../analyzers/learning-capture";
import { saveRun, loadRun } from "../persistence/run-store";
import { saveReport, loadReport } from "../persistence/report-store";
import { saveFindingIndex, loadFindingIndex } from "../persistence/finding-store";
import { saveIgnoredFinding, loadIgnoredFindings } from "../persistence/ignored-finding-store";
import { saveRepairSession, loadRepairSession } from "../persistence/repair-session-store";
import { readSessionRecords } from "../opencode/session-reader";
import { analyzeSessions } from "../opencode/session-analyzer";
import { createRepairSession } from "../opencode/repair-session";
import { buildRepairPrompt } from "../opencode/repair-prompt";
import { executeValidation } from "../opencode/validation-executor";
import { createHash, randomBytes } from "crypto";
import { realpathSync, existsSync } from "fs";
import { normalize, sep } from "path";

export const registry = {
  collectors: {
    customization: customizationCollector,
    foundations: foundationCollector,
    sessions: sessionCollector,
  },
  analyzers: {
    taskUnderstanding: analyzeTaskUnderstanding,
    controlledExecution: analyzeControlledExecution,
    changeValidation: analyzeChangeValidation,
    reliableDelivery: analyzeReliableDelivery,
    learningCapture: analyzeLearningCapture,
  },
  stores: {
    run: { save: saveRun, load: loadRun },
    report: { save: saveReport, load: loadReport },
    finding: { save: saveFindingIndex, load: loadFindingIndex },
    ignoredFinding: { save: saveIgnoredFinding, load: loadIgnoredFindings },
    repairSession: { save: saveRepairSession, load: loadRepairSession },
  },
  opencode: {
    readSessionRecords,
    analyzeSessions,
    createRepairSession,
    buildRepairPrompt,
    executeValidation,
  },
};

// ── Constants ──────────────────────────────────────────────────────────

export const BH_CONTRACT_VERSION = "1.0.0";
export const BH_SCHEMA_VERSION = 1;

// ── Identity ───────────────────────────────────────────────────────────

/** Process-scoped crypto-random server identity (128 bits). */
const SERVER_KEY: string = randomBytes(16).toString("hex");
export function getServerKey(): string { return SERVER_KEY; }

/**
 * Canonicalize a project root: resolve to absolute, follow symlinks,
 * normalize separators and dot segments.
 */
export function canonicalize(root: string): string {
  if (!root || typeof root !== "string") throw new Error("Invalid project root");
  if (!existsSync(root)) throw new Error("Project root does not exist: " + root);
  let r = realpathSync(root);
  r = normalize(r);
  if (sep === "\\") r = r.replace(/\\/g, "/");
  return r;
}

/** Stable opaque project identity (128 bits) from canonical root. */
export function opaqueProjectId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32);
}

// ── State machine ──────────────────────────────────────────────────────

export type BhState = "starting" | "running" | "stopping" | "stopped" | "failed";

/** Legal transitions: starting->running, starting->failed, running->stopping, stopping->stopped */
const VALID_TRANSITIONS: Record<BhState, BhState[]> = {
  starting: ["running", "failed"],
  running: ["stopping"],
  stopping: ["stopped"],
  stopped: [],
  failed: [],
};

function transition(from: BhState, to: BhState): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) throw new Error(`Invalid state transition: ${from} -> ${to}`);
}

export interface BhEntry {
  canonicalRoot: string;
  serverKey: string;
  projectKey: string;
  state: BhState;
  startupPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  startupError?: string;
  startedAt?: string;
  /** Single cleanup function — first caller runs it, concurrent callers await the promise. */
  stop: () => Promise<void>;
}

const entries = new Map<string, BhEntry>();
const pending = new Map<string, { promise: Promise<void>; cancel: () => void }>();

/**
 * Start Better Harness for a project. Idempotent — concurrent calls share
 * one startup promise.  All resource creation is inside `factory`.  On
 * failure, only successfully-created resources are rolled back in reverse
 * order (handled by the caller in the factory's catch).
 */
export async function startBh(
  rawRoot: string,
  factory: () => Promise<BhEntry>,
): Promise<void> {
  // Resolve canonical root for the registry key
  const canonicalRoot = canonicalize(rawRoot);

  const existing = entries.get(canonicalRoot);
  if (existing && existing.state !== "stopped" && existing.state !== "failed") return;

  const inFlight = pending.get(canonicalRoot);
  if (inFlight) return;

  // Reserve entry in "starting" state
  const entry: BhEntry = {
    canonicalRoot, serverKey: getServerKey(), projectKey: opaqueProjectId(canonicalRoot),
    state: "starting", stop: async () => {},
  };
  entries.set(canonicalRoot, entry);

  const cancelled = { value: false };
  const promise = (async () => {
    try {
      const result = await factory();
      // If cancellation was requested during startup, clean up immediately
      if (cancelled.value) {
        await result.stop();
        entries.delete(canonicalRoot);
        return;
      }
      entry.serverKey = result.serverKey;
      entry.projectKey = result.projectKey;
      entry.stop = result.stop;
      entry.startedAt = result.startedAt || new Date().toISOString();
      transition(entry.state, "running");
      entry.state = "running";
      entries.set(canonicalRoot, entry);
    } catch (err) {
      // Failed startup — remove entry, allow retry
      entries.delete(canonicalRoot);
      throw err;
    } finally {
      pending.delete(canonicalRoot);
    }
  })();

  pending.set(canonicalRoot, { promise, cancel: () => { cancelled.value = true; } });
}

/** Stop Better Harness. Idempotent — first call runs cleanup, concurrent calls await. */
export async function stopBh(canonicalRoot: string): Promise<void> {
  // Cancel pending startup
  const p = pending.get(canonicalRoot);
  if (p) {
    p.cancel();
    pending.delete(canonicalRoot);
  }

  const entry = entries.get(canonicalRoot);
  if (!entry) return;
  if (entry.state === "stopping" || entry.state === "stopped") {
    // Await existing cleanup if in progress
    if (entry.cleanupPromise) await entry.cleanupPromise;
    return;
  }

  transition(entry.state, "stopping");
  entry.state = "stopping";

  if (!entry.cleanupPromise) {
    entry.cleanupPromise = (async () => {
      try {
        await entry.stop();
      } catch (err) {
        console.error("[better-harness] Cleanup error:", (err as Error).message);
      }
      transition(entry.state, "stopped");
      entry.state = "stopped";
      entries.delete(canonicalRoot);
    })();
  }

  await entry.cleanupPromise;
}

/** Get entry for a canonical root. */
export function getBh(canonicalRoot: string): BhEntry | undefined {
  return entries.get(canonicalRoot);
}

/** Build state-backed discovery response. */
export function getDiscovery(
  serverKey: string, projectKey: string,
  canonicalRoot?: string, authRequired = false,
): Record<string, unknown> {
  const entry = canonicalRoot ? entries.get(canonicalRoot) : undefined;
  const state = entry?.state ?? (canonicalRoot ? "stopped" : "unknown");
  const available = state === "running";
  return {
    available, enabled: true, state,
    contractVersion: BH_CONTRACT_VERSION,
    schemaVersion: BH_SCHEMA_VERSION,
    serverKey, projectKey,
    authRequired,
    capabilities: ["run", "report", "history", "cancel", "plan-fix", "verify", "ignore", "batch", "sse"],
    startedAt: entry?.startedAt,
    reason: !available ? `Better Harness is ${state}` : undefined,
  };
}
