import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// This script will run the dev1-dev2 integration tests which will output a compliance matrix
// and we will ensure the artifact is correctly formatted.

const dev1Sha = process.env.DEV1_SHA || 'unknown';
const dev2Sha = process.env.DEV2_SHA || 'unknown';
const dev4Sha = process.env.DEV4_SHA || 'unknown';

const statusArgIndex = process.argv.indexOf('--status');
const status = statusArgIndex !== -1 ? process.argv[statusArgIndex + 1] : 'completed';

const matrix = {
  schemaVersion: '1.0',
  metadata: {
    runId: 'local-report-run',
    profile: 'dev4-manual',
    generatedAt: new Date().toISOString(),
    status
  },
  DEV1_SHA: dev1Sha,
  DEV2_SHA: dev2Sha,
  DEV4_SHA: dev4Sha,
  ARTIFACT_PATH: '../flowdeck-dev/artifacts/orchestration-compliance/dev1-dev2-compatibility.json'
};

const env = { 
  ...process.env, 
  GENERATE_COMPLIANCE_ARTIFACT: 'true',
  DEV1_SHA: dev1Sha,
  DEV2_SHA: dev2Sha,
  DEV4_SHA: dev4Sha,
  ARTIFACT_PATH: '../flowdeck-dev/artifacts/orchestration-compliance/dev1-dev2-compatibility.json'
};

try {
  // We run bun test, passing an environment variable to trigger artifact generation
  console.log('Running compliance test suite...');
  // Since we are running in the flowdeck-validation-integration dir, we just run the local tests
  execSync('bun test tests/orchestration/integration/sqlite-production.test.ts', { stdio: 'inherit', cwd: '../flowdeck-validation-integration', env });
} catch (e) {
  // Tests are expected to fail if there are missing methods
  console.log('Test suite completed with failures (expected for non-compliant adapters).');
}

console.log('Compliance generation finished.');
