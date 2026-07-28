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
import { createHash } from "crypto";

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

// ── Idempotent startup registry ────────────────────────────────────────

/** Generate a stable opaque 12-char hex identity from a canonical path. */
export function opaqueId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 12);
}

interface BhEntry {
  serverKey: string;
  projectKey: string;
  stop: () => Promise<void>;
}

const bhEntries = new Map<string, BhEntry>();
const bhPending = new Map<string, Promise<BhEntry>>();

/**
 * Start Better Harness for a project, or return the existing entry.
 * Concurrent calls share the same startup promise.
 */
export async function startBh(
  canonicalRoot: string,
  factory: () => Promise<BhEntry>,
): Promise<BhEntry> {
  const existing = bhEntries.get(canonicalRoot);
  if (existing) return existing;
  const inFlight = bhPending.get(canonicalRoot);
  if (inFlight) return inFlight;
  const promise = factory().then((e) => {
    bhEntries.set(canonicalRoot, e);
    bhPending.delete(canonicalRoot);
    return e;
  }).catch((err) => {
    bhPending.delete(canonicalRoot);
    throw err;
  });
  bhPending.set(canonicalRoot, promise);
  return promise;
}

/** Stop and remove the entry for a project. Safe to call multiple times. */
export async function stopBh(canonicalRoot: string): Promise<void> {
  const e = bhEntries.get(canonicalRoot);
  if (!e) return;
  try { await e.stop(); } catch {}
  bhEntries.delete(canonicalRoot);
}
