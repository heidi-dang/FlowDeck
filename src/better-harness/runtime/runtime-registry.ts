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
import { normalize, sep, win32 } from "path";

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

// ── Identity ───────────────────────────────────────────────────────────

const CONTRACT_VERSION = "1.0.0";
const SCHEMA_VERSION = 1;

/** Process-scoped crypto-random server identity (128 bits). Never changes within one process lifetime. */
const SERVER_KEY: string = randomBytes(16).toString("hex");
export function getServerKey(): string { return SERVER_KEY; }

/**
 * Canonicalize a project root path:
 * 1. Resolve to absolute
 * 2. Resolve symlinks via realpath
 * 3. Normalize separators and dot segments
 * 4. Validate the path exists and is accessible
 * Throws on invalid or inaccessible roots.
 */
export function canonicalize(root: string): string {
  if (!root || typeof root !== "string") throw new Error(`Invalid project root: ${root}`);
  if (!existsSync(root)) throw new Error(`Project root does not exist: ${root}`);
  let resolved = realpathSync(root);
  resolved = normalize(resolved);
  // Normalize Windows-style separators to forward slashes for consistency
  if (sep === "\\") resolved = resolved.replace(/\\/g, "/");
  return resolved;
}

/**
 * Generate a stable opaque project identity (128 bits) from the canonical root.
 */
export function opaqueProjectId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32);
}

// ── State machine ──────────────────────────────────────────────────────

export type BhState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface BhEntry {
  serverKey: string;
  projectKey: string;
  canonicalRoot: string;
  state: BhState;
  startupError?: string;
  startedAt?: string;
  stop: () => Promise<void>;
  // Internal references held for cleanup (not exposed to consumers)
  _cleanup?: () => Promise<void>;
}

interface PendingEntry {
  promise: Promise<BhEntry>;
  cancel: () => void;
}

const entries = new Map<string, BhEntry>();
const pending = new Map<string, PendingEntry>();

/**
 * Start Better Harness for a canonical project root.
 * Idempotent: returns existing entry if already started.
 * Concurrent calls share one startup promise.
 */
export async function startBh(
  canonicalRoot: string,
  factory: () => Promise<BhEntry>,
): Promise<BhEntry> {
  const existing = entries.get(canonicalRoot);
  if (existing && existing.state !== "stopped" && existing.state !== "failed") return existing;

  const inFlight = pending.get(canonicalRoot);
  if (inFlight) return inFlight.promise;

  const cancelToken = { cancelled: false };
  const promise = (async () => {
    try {
      const entry = await factory();
      if (!cancelToken.cancelled) {
        entry.state = "running";
        entry.startedAt = new Date().toISOString();
        entries.set(canonicalRoot, entry);
      }
      pending.delete(canonicalRoot);
      return entry;
    } catch (err) {
      pending.delete(canonicalRoot);
      // Register failed state so retry is possible
      const failedEntry: BhEntry = {
        serverKey: SERVER_KEY,
        projectKey: opaqueProjectId(canonicalRoot),
        canonicalRoot,
        state: "failed",
        startupError: err instanceof Error ? err.message : String(err),
        stop: async () => {},
      };
      entries.set(canonicalRoot, failedEntry);
      throw err;
    }
  })();

  pending.set(canonicalRoot, { promise, cancel: () => { cancelToken.cancelled = true; } });
  return promise;
}

/** Stop and remove the entry. Idempotent. */
export async function stopBh(canonicalRoot: string): Promise<void> {
  const p = pending.get(canonicalRoot);
  if (p) {
    p.cancel();
    pending.delete(canonicalRoot);
  }
  const e = entries.get(canonicalRoot);
  if (!e) return;
  if (e.state === "stopping" || e.state === "stopped") return;
  e.state = "stopping";
  try {
    if (e._cleanup) await e._cleanup();
    await e.stop();
  } catch {}
  e.state = "stopped";
  entries.delete(canonicalRoot);
}

/** Get the current entry for a canonical root. */
export function getBh(canonicalRoot: string): BhEntry | undefined {
  return entries.get(canonicalRoot);
}

/** Build discovery response from registry state. */
export function getDiscovery(
  serverKey: string,
  projectKey: string,
  canonicalRoot?: string,
  authRequired = false,
): Record<string, unknown> {
  const entry = canonicalRoot ? entries.get(canonicalRoot) : undefined;
  const state = entry?.state ?? (canonicalRoot ? "stopped" : "unknown");
  const available = state === "running";
  return {
    available,
    enabled: true,
    state,
    contractVersion: CONTRACT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    serverKey,
    projectKey,
    authRequired,
    capabilities: ["run", "report", "history", "cancel", "plan-fix", "verify", "ignore", "batch", "sse"],
    startedAt: entry?.startedAt,
    reason: !available ? `Better Harness is ${state}` : undefined,
  };
}
