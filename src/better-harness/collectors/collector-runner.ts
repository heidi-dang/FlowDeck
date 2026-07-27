import type { HarnessEvidence } from "../contracts/report";
import { customizationCollector } from "./customization-collector";
import { foundationCollector } from "./foundation-collector";
import { sessionCollector } from "./session-collector";
import { deduplicateEvidence } from "../evidence/evidence-deduplicator";

export interface CollectorResult {
  collectorName: string;
  evidence: HarnessEvidence[];
  error: string | null;
}

export async function runAllCollectors(root: string): Promise<{
  evidence: HarnessEvidence[];
  collectorResults: CollectorResult[];
}> {
  const collectors = [
    { name: "customization", run: () => customizationCollector.collect(root) },
    { name: "foundations", run: () => foundationCollector.collect(root) },
    { name: "sessions", run: () => sessionCollector.collect(root) },
  ];

  const results: CollectorResult[] = await Promise.all(
    collectors.map(async (c) => {
      try {
        const evidence = await Promise.resolve(c.run());
        return { collectorName: c.name, evidence, error: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { collectorName: c.name, evidence: [], error: msg };
      }
    }),
  );

  const allEvidence = results.flatMap((r) => r.evidence);
  const deduplicated = deduplicateEvidence(allEvidence);

  return { evidence: deduplicated, collectorResults: results };
}
