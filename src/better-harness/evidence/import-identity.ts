/**
 * Deterministic identities for canonical evidence import.
 *
 * Pure, side-effect-free functions that derive stable identities from the
 * immutable inputs of an import:
 *
 *  - report fingerprint:      stable across identical report content, changes
 *                             when report content changes (test 20)
 *  - evidence content hash:   deterministic content fingerprint (test 18)
 *  - import idempotency key:  per source evidence item, derived from
 *                             runId + target SHA + harness run + report
 *                             fingerprint + finding + evidence ids (test 19)
 *  - evidence id:             deterministic from the import key — retries map
 *                             to the same evidence row (no random ids)
 *
 * These functions are kept separate from the adapter so they can be unit
 * tested directly (pure hashing / canonical JSON).
 */

import { createHash } from "node:crypto";

/** Canonical JSON with sorted keys — insertion-order independent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of the given UTF-8 input. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic report fingerprint. Excludes `generatedAt` (timing metadata,
 * not evidence content) so an identical report re-collected at a different
 * time maps to the same fingerprint; any change to findings, evidence,
 * sourceRevision, scoring or session/asset counts changes the fingerprint.
 */
export function reportFingerprint(report: {
  schemaVersion?: unknown;
  engineVersion?: unknown;
  scoringVersion?: unknown;
  sourceRevision?: unknown;
  project?: unknown;
  overallScore?: unknown;
  previousOverallScore?: unknown;
  evidenceCoverage?: unknown;
  dimensions?: unknown;
  findings?: unknown;
  sessions?: unknown;
  assets?: unknown;
}): string {
  const stable: Record<string, unknown> = {
    schemaVersion: report.schemaVersion,
    engineVersion: report.engineVersion,
    scoringVersion: report.scoringVersion,
    sourceRevision: report.sourceRevision ?? null,
    project: report.project ?? null,
    overallScore: report.overallScore,
    previousOverallScore: report.previousOverallScore ?? null,
    evidenceCoverage: report.evidenceCoverage,
    dimensions: report.dimensions ?? [],
    findings: report.findings ?? [],
    sessions: report.sessions ?? null,
    assets: report.assets ?? null,
  };
  return sha256Hex(canonicalJson(stable));
}

/** Deterministic content hash for a single source evidence item. */
export function evidenceContentHash(evidence: {
  id?: unknown;
  category?: unknown;
  source?: unknown;
  summary?: unknown;
  path?: unknown;
  sessionId?: unknown;
  confidence?: unknown;
  collectedAt?: unknown;
  fingerprint?: unknown;
}): string {
  return sha256Hex(canonicalJson({
    id: evidence.id ?? null,
    category: evidence.category ?? null,
    source: evidence.source ?? null,
    summary: evidence.summary ?? null,
    path: evidence.path ?? null,
    sessionId: evidence.sessionId ?? null,
    confidence: evidence.confidence ?? null,
    collectedAt: evidence.collectedAt ?? null,
    fingerprint: evidence.fingerprint ?? null,
  }));
}

export interface ImportIdentityParts {
  readonly runId: string;
  readonly targetSha: string;
  readonly harnessRunId: string;
  readonly reportFingerprint: string;
  readonly findingId: string;
  readonly evidenceId: string;
}

/**
 * Deterministic per-item idempotency key. Any change to run, SHA, harness
 * run, report content or the source evidence item yields a different key, so
 * a changed report or changed SHA never collides with a previous import.
 */
export function importIdempotencyKey(parts: ImportIdentityParts): string {
  return sha256Hex(canonicalJson({
    kind: "better-harness-evidence-import",
    runId: parts.runId,
    targetSha: parts.targetSha,
    harnessRunId: parts.harnessRunId,
    reportFingerprint: parts.reportFingerprint,
    findingId: parts.findingId,
    evidenceId: parts.evidenceId,
  }));
}

/**
 * Deterministic canonical evidence id derived from the import key. Retrying
 * the same import yields the same id, so retries cannot create duplicates and
 * no random id generator is required for identity.
 */
export function evidenceIdFromImportKey(importKey: string): string {
  return `ev_${sha256Hex(importKey).slice(0, 40)}`;
}

/** Deterministic event id for the batch-level evidence.imported event. */
export function importEventId(runId: string, targetSha: string, reportFingerprint: string): string {
  return `evt_${sha256Hex(canonicalJson({ runId, targetSha, reportFingerprint })).slice(0, 40)}`;
}
