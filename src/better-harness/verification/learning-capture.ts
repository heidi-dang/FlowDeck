import type { HarnessFinding } from "../contracts/report";
import type { HarnessFixVehicle } from "../contracts/common";

export interface LearningProposal {
  findingId: string;
  title: string;
  recommendedVehicle: HarnessFixVehicle;
  content: string;
  requiresApproval: boolean;
  targetPath: string;
}

export function generateLearningProposal(finding: HarnessFinding): LearningProposal {
  const vehiclePathMap: Record<string, string> = {
    rule: "src/rules/",
    skill: "src/skills/",
    hook: "src/hooks/",
    script: "scripts/",
    command: "src/commands/",
    agent: "src/agents/",
    "ci-workflow": ".github/workflows/",
    automation: "scripts/",
    "human-gate": "docs/",
    documentation: "docs/",
  };

  const targetPath = vehiclePathMap[finding.recommendedVehicle] ?? "docs/";

  return {
    findingId: finding.id,
    title: finding.title,
    recommendedVehicle: finding.recommendedVehicle,
    content: `# Learning: ${finding.title}\n\n## Cause\n${finding.cause}\n\n## Resolution\n${finding.expectedOutput}\n\n## Prevention\n- ${finding.validationRequirements.join("\n- ")}\n`,
    requiresApproval: true,
    targetPath,
  };
}
