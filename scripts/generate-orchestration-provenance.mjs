import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const COMPLIANCE_PATH = 'artifacts/orchestration-compliance/dev1-dev2-compatibility.json';
const PROVENANCE_PATH = 'artifacts/orchestration-compliance/failure-provenance.json';

if (!existsSync(COMPLIANCE_PATH)) {
  console.log('No compliance artifact found. Run npm run test:orchestration:dev1-dev2 first.');
  process.exit(0);
}

const compliance = JSON.parse(readFileSync(COMPLIANCE_PATH, 'utf-8'));

const statusArgIndex = process.argv.indexOf('--status');
const status = statusArgIndex !== -1 ? process.argv[statusArgIndex + 1] : 'completed';

const provenance = {
  baseSha: 'origin/main',
  integrationDev1Sha: compliance.DEV1_SHA || compliance.dev1Sha,
  integrationDev2Sha: compliance.DEV2_SHA || compliance.dev2Sha,
  status,
  failures: []
};

for (const matrix of compliance.matrices) {
  if (matrix.status === 'non_compliant') {
    provenance.failures.push({
      port: matrix.port,
      implementation: matrix.implementation,
      missingMethods: matrix.missingMethods,
      semanticFailures: matrix.semanticFailures || [],
      classification: matrix.implementation === 'Missing Implementation' ? 'introduced by Dev 2' : 'integration mismatch'
    });
  }
}

writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2));
console.log('Failure provenance written to', PROVENANCE_PATH);
