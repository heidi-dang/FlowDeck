import type { HarnessEvidence } from "../contracts/report";

export function deduplicateEvidence(evidence: HarnessEvidence[]): HarnessEvidence[] {
  const byFingerprint = new Map<string, HarnessEvidence>();

  for (const item of evidence) {
    const existing = byFingerprint.get(item.fingerprint);
    if (!existing || item.confidence > existing.confidence) {
      byFingerprint.set(item.fingerprint, item);
    }
  }

  return Array.from(byFingerprint.values());
}
