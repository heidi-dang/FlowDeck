import { HarnessCollectorCategoryEnum, type HarnessCollectorCategory } from "../contracts/common";
import type { HarnessEvidence } from "../contracts/report";
import { generateEvidenceFingerprint } from "./evidence-fingerprint";

export interface RawCollectorEvidence {
  category: HarnessCollectorCategory;
  source: string;
  summary: string;
  path?: string;
  sessionId?: string;
  confidence: number;
}

export function normalizeEvidence(
  raw: RawCollectorEvidence[],
): HarnessEvidence[] {
  return raw.map((r) => {
    const parsed = HarnessCollectorCategoryEnum.safeParse(r.category);
    return {
      id: generateId(r),
      category: parsed.success ? parsed.data : "customization" as HarnessCollectorCategory,
      source: r.source,
      summary: r.summary,
      path: r.path,
      sessionId: r.sessionId,
      confidence: Math.max(0, Math.min(1, r.confidence)),
      collectedAt: new Date().toISOString(),
      fingerprint: generateEvidenceFingerprint(r.category, r.source, r.summary),
    };
  });
}

function generateId(raw: RawCollectorEvidence): string {
  const hash = generateEvidenceFingerprint(raw.category, raw.source, raw.summary);
  return `ev_${hash}`;
}
