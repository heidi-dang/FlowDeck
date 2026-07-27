import { createHash } from "crypto";

export function generateEvidenceFingerprint(
  category: string,
  source: string,
  summary: string
): string {
  const normalized = `${category.toLowerCase().trim()}|${source.toLowerCase().trim()}|${summary.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
