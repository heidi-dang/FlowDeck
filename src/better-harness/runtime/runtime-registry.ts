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

export const BH_CONTRACT_VERSION = "1.0.0";
export const BH_SCHEMA_VERSION = 1;

// ── Identity ───────────────────────────────────────────────────────────

const SERVER_KEY: string = randomBytes(16).toString("hex");
export function getServerKey(): string { return SERVER_KEY; }

export function canonicalize(root: string): string {
  if (!root || typeof root !== "string") throw new Error("Invalid project root");
  if (!existsSync(root)) throw new Error("Project root does not exist: " + root);
  let r = realpathSync(root);
  r = normalize(r);
  if (sep === "\\") r = r.replace(/\\/g, "/");
  return r;
}

export function opaqueProjectId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32);
}

// ── State machine ──────────────────────────────────────────────────────

export type BhState = "starting" | "running" | "stopping" | "stopped" | "failed";

const TRANSITIONS: Record<BhState, BhState[]> = {
  starting: ["running", "stopping", "failed"],
  running: ["stopping"],
  stopping: ["stopped"],
  stopped: ["starting"],
  failed: ["starting"],
};

export function validTransition(from: BhState, to: BhState): boolean {
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from: BhState, to: BhState): void {
  if (!validTransition(from, to)) throw new Error(`Invalid transition: ${from} -> ${to}`);
}

// ── Entry ──────────────────────────────────────────────────────────────

export interface BhEntry {
  canonicalRoot: string;
  serverKey: string;
  projectKey: string;
  state: BhState;
  startupPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  cleanupErrors?: string[];
  startupError?: string;
  startedAt?: string;
  stop: () => Promise<void>;
}

const entries = new Map<string, BhEntry>();
const pending = new Map<string, Promise<void>>();
let cancelFlag: (() => void) | null = null;

/** Start BH — returns the shared promise. Idempotent for concurrent callers. */
export function startBh(
  rawRoot: string,
  factory: () => Promise<BhEntry>,
): Promise<void> {
  const canonicalRoot = canonicalize(rawRoot);
  const existing = entries.get(canonicalRoot);
  if (existing && existing.state !== "stopped" && existing.state !== "failed") {
    return existing.startupPromise || Promise.resolve();
  }

  const inFlight = pending.get(canonicalRoot);
  if (inFlight) return inFlight;

  const entry: BhEntry = {
    canonicalRoot, serverKey: getServerKey(), projectKey: opaqueProjectId(canonicalRoot),
    state: "starting", stop: async () => {},
  };
  entries.set(canonicalRoot, entry);

  const cancelled = { value: false };
  cancelFlag = () => { cancelled.value = true; };

  const promise = (async () => {
    try {
      const result = await factory();
      if (cancelled.value) {
        await result.stop();
        entries.delete(canonicalRoot);
        return;
      }
      entry.serverKey = result.serverKey;
      entry.projectKey = result.projectKey;
      entry.stop = result.stop;
      entry.startedAt = result.startedAt || new Date().toISOString();
      assertTransition(entry.state, "running");
      entry.state = "running";
      entries.set(canonicalRoot, entry);
    } catch (err) {
      entries.delete(canonicalRoot);
      throw err;
    } finally {
      pending.delete(canonicalRoot);
    }
  })();

  entry.startupPromise = promise;
  pending.set(canonicalRoot, promise);
  return promise;
}

/** Stop BH. Idempotent. */
export async function stopBh(rawRoot: string): Promise<void> {
  if (cancelFlag) cancelFlag();
  const canonicalRoot = canonicalize(rawRoot);
  const entry = entries.get(canonicalRoot);
  if (!entry) return;

  if (entry.state === "stopping" || entry.state === "stopped") {
    if (entry.cleanupPromise) await entry.cleanupPromise;
    return;
  }

  assertTransition(entry.state, "stopping");
  entry.state = "stopping";

  if (!entry.cleanupPromise) {
    entry.cleanupPromise = (async () => {
      const errors: string[] = [];
      try { await entry.stop(); } catch (e) { errors.push((e as Error).message); }
      entry.cleanupErrors = errors;
      assertTransition(entry.state, "stopped");
      entry.state = "stopped";
      entries.delete(canonicalRoot);
    })();
  }

  await entry.cleanupPromise;
}

export function getBh(canonicalRoot: string): BhEntry | undefined {
  return entries.get(canonicalRoot);
}

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

/** Original registry of all BH modules, augmented with lifecycle functions. */
export const registry = {
  canonicalize, getServerKey, opaqueProjectId, startBh, stopBh, getDiscovery, validTransition,
  BH_CONTRACT_VERSION, BH_SCHEMA_VERSION,
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

/** Internal: used by tests to reset state. */
export function _resetForTesting(): void {
  entries.clear();
  pending.clear();
}
