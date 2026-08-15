import type { CheckResult } from "../types";
import { DesignSystemIndexer } from "../../studio/design-system-index";

export async function runStudioChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  try {
    const indexer = new DesignSystemIndexer(directory);
    const ds = indexer.indexProject();

    checks.push({
      id: "studio.readiness",
      title: "Heidi UI/App Studio Subsystem",
      category: "configuration",
      severity: "low",
      status: "pass",
      detected: `Framework: ${ds.framework}, Components: ${ds.components.length}, Tailwind: ${ds.hasTailwind ? "yes" : "no"}, Shadcn: ${ds.hasShadcn ? "yes" : "no"}`,
      expected: "UI/App Studio design system indexer active and ready",
      recommendation: "OK — Heidi UI/App Studio is active and ready for UI/app creation",
      autoFixAvailable: false,
    });
  } catch (err) {
    checks.push({
      id: "studio.readiness",
      title: "Heidi UI/App Studio Subsystem",
      category: "configuration",
      severity: "medium",
      status: "warning",
      detected: `Studio indexer error: ${err instanceof Error ? err.message : String(err)}`,
      expected: "DesignSystemIndexer initialized cleanly",
      recommendation: "Ensure project root contains a readable package.json or component directory",
      autoFixAvailable: false,
    });
  }

  return checks;
}
