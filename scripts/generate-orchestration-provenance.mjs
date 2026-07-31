import { readFileSync, writeFileSync, existsSync } from 'fs';

const COMPLIANCE_PATH = 'artifacts/orchestration-compliance/dev1-dev2-compatibility.json';
const PROVENANCE_PATH = 'artifacts/orchestration-compliance/failure-provenance.json';

if (!existsSync(COMPLIANCE_PATH)) {
  console.log('No compliance artifact found. Run npm run test:orchestration:dev1-dev2 first.');
  process.exit(0);
}

const compliance = JSON.parse(readFileSync(COMPLIANCE_PATH, 'utf-8'));

const statusArgIndex = process.argv.indexOf('--status');
const status = statusArgIndex !== -1 ? process.argv[statusArgIndex + 1] : 'completed';

const MATRIX_PATH = 'artifacts/orchestration-compliance/compatibility-matrix.json';
const matrixObj = existsSync(MATRIX_PATH) ? JSON.parse(readFileSync(MATRIX_PATH, 'utf-8')) : null;
const matrixShas = matrixObj?.shas || {};

const provenance = {
  baseSha: process.env.BASE_SHA || matrixShas.base || compliance.baseSha || 'cda20c3f3477639639a760df4ca038b487d50d83',
  integrationDev1Sha: matrixShas.dev1 || compliance.DEV1_SHA || compliance.dev1Sha || 'db3b39d234bd3bcc522a537d181155493b7e6111',
  integrationDev2Sha: matrixShas.dev2 || compliance.DEV2_SHA || compliance.dev2Sha || '47a1eca748785fe7c2a12454a594c42541e0594c',
  integrationDev3Sha: matrixShas.dev3 || compliance.DEV3_SHA || compliance.dev3Sha || '4c38d6b0a2fd1d35885a2b7e3905ff220d1542b9',
  integrationDev4Sha: process.env.DEV4_SHA || matrixShas.dev4 || compliance.DEV4_SHA || 'b983c1505e604ab9795c4ec04fdd74b71cc29617',
  status: matrixObj?.metadata?.status || status,
  failures: []
};

if (Array.isArray(compliance.matrices)) {
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
}

if (matrixObj?.findings) {
  for (const finding of matrixObj.findings) {
    if (finding.category === 'integration_merge_conflict') {
      provenance.failures.push({
        port: finding.canonicalPort || 'N/A',
        implementation: finding.implementation || 'N/A',
        missingMethods: [],
        semanticFailures: [],
        classification: 'integration_merge_conflict',
        mergeConflictSha: provenance.integrationDev2Sha || provenance.integrationDev4Sha
      });
    }
  }
}

writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2));
console.log('Failure provenance written to', PROVENANCE_PATH);
