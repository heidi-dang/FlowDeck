import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const artifactsDir = join(process.cwd(), 'artifacts', 'orchestration-compliance');
let matrix;

try {
  matrix = JSON.parse(readFileSync(join(artifactsDir, 'compatibility-matrix.json'), 'utf8'));
} catch {
  console.error('Failed to read compatibility-matrix.json');
  process.exit(1);
}

let md = `# Orchestration Validation - Repair Handoff

**Run ID:** ${matrix.metadata.runId}
**Profile:** ${matrix.metadata.profile}
**Generated At:** ${matrix.metadata.generatedAt}

## SHAs
- Base: \`${matrix.shas.base}\`
- Dev 1: \`${matrix.shas.dev1}\`
- Dev 2: \`${matrix.shas.dev2}\`
- Dev 3: \`${matrix.shas.dev3}\`
- Dev 4: \`${matrix.shas.dev4}\`

## Findings
`;

if (!matrix.findings || matrix.findings.length === 0) {
  md += `\nNo failures found. Integration is 100% compliant.\n`;
} else {
  matrix.findings.forEach(finding => {
    md += `
### [${finding.id}] ${finding.category}
**Owner:** ${finding.owner}
**Canonical Port:** ${finding.canonicalPort}
**Implementation:** ${finding.implementation}

**Expected:** ${finding.expectedBehavior}
**Observed:** ${finding.observedBehavior}

<details>
<summary>Root Error</summary>

\`\`\`
${finding.rootError}
\`\`\`
</details>

`;
  });
}

writeFileSync(join(artifactsDir, 'repair-handoff.md'), md);
console.log('repair-handoff.md generated successfully.');
