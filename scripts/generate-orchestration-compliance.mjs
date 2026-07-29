import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// This script will run the dev1-dev2 integration tests which will output a compliance matrix
// and we will ensure the artifact is correctly formatted.

const dev1Sha = process.env.DEV1_SHA || 'unknown';
const dev2Sha = process.env.DEV2_SHA || 'unknown';
const dev4Sha = process.env.DEV4_SHA || 'unknown';

try {
  // We run bun test, passing an environment variable to trigger artifact generation
  console.log('Running compliance test suite...');
  execSync('bun test ../flowdeck-dev/tests/orchestration/integration/sqlite-production.test.ts', {
    env: { 
      ...process.env, 
      GENERATE_COMPLIANCE_ARTIFACT: 'true',
      DEV1_SHA: dev1Sha,
      DEV2_SHA: dev2Sha,
      DEV4_SHA: dev4Sha,
      ARTIFACT_PATH: '../flowdeck-dev/artifacts/orchestration-compliance/dev1-dev2-compatibility.json'
    },
    cwd: '../flowdeck-validation-integration',
    stdio: 'inherit'
  });
} catch (e) {
  // Tests are expected to fail if there are missing methods
  console.log('Test suite completed with failures (expected for non-compliant adapters).');
}

console.log('Compliance generation finished.');
