import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const artifactsDir = process.env.ORCHESTRATION_ARTIFACT_DIR || join(process.cwd(), 'artifacts', 'orchestration-compliance');

const VALID_STATUSES = [
  'completed',
  'blocked_by_merge_conflict',
  'failed_during_validation',
  'failed_by_runtime_crash'
];

function validateSha(sha, context = 'SHA') {
  if (!sha || typeof sha !== 'string') {
    throw new Error(`Missing ${context}`);
  }
  if (sha === 'unknown') {
    throw new Error(`Placeholder ${context}: 'unknown'`);
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Invalid 40-hex ${context}: '${sha}'`);
  }
}

function checkNoAbsolutePaths(obj, pathName = '$') {
  if (typeof obj === 'string') {
    // Check for Windows or Unix absolute paths or temporary worktree directory leaks
    if (/([a-zA-Z]:[/\\]Users[/\\]|[/\\]tmp[/\\]flowdeck-|\/Users\/|\/home\/)/i.test(obj)) {
      // Ignore if it's git status porcelain output detailing file paths in merge conflicts
      if (!obj.includes('README.md') && !obj.includes('package.json') && !obj.includes('docs/')) {
        throw new Error(`Absolute or temporary path leak detected in ${pathName}: "${obj.substring(0, 80)}"`);
      }
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (key === 'repoRoot' || key === 'worktreePath') continue; // Expected internal marker properties if any
      checkNoAbsolutePaths(obj[key], `${pathName}.${key}`);
    }
  }
}

function validateMatrix() {
  const p = join(artifactsDir, 'compatibility-matrix.json');
  if (!existsSync(p)) {
    throw new Error(`Missing required artifact file: ${p}`);
  }

  let matrix;
  try {
    matrix = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Malformed JSON in ${p}: ${err.message}`);
  }

  if (!matrix || typeof matrix !== 'object') {
    throw new Error(`Invalid object in ${p}`);
  }

  if (matrix.schemaVersion !== '1.0') {
    throw new Error(`Unsupported schema version in ${p}: ${matrix.schemaVersion}`);
  }

  if (!matrix.metadata || typeof matrix.metadata !== 'object') {
    throw new Error(`Missing metadata object in ${p}`);
  }

  if (!matrix.metadata.runId || typeof matrix.metadata.runId !== 'string') {
    throw new Error(`Missing or invalid runId in metadata in ${p}`);
  }

  if (!matrix.metadata.status || !VALID_STATUSES.includes(matrix.metadata.status)) {
    throw new Error(`Invalid status in ${p}: ${matrix.metadata.status}`);
  }

  if (!matrix.shas || typeof matrix.shas !== 'object') {
    throw new Error(`Missing shas mapping in ${p}`);
  }

  validateSha(matrix.shas.base, 'shas.base');
  validateSha(matrix.shas.dev1, 'shas.dev1');
  validateSha(matrix.shas.dev2, 'shas.dev2');
  validateSha(matrix.shas.dev3, 'shas.dev3');
  validateSha(matrix.shas.dev4, 'shas.dev4');

  if (matrix.metadata.status === 'completed') {
    if (matrix.findings && matrix.findings.length > 0) {
      const failedRequired = matrix.findings.some(f => f.evidenceLevel === 'confirmed' || f.category === 'integration_merge_conflict');
      if (failedRequired) {
        throw new Error(`Status 'completed' cannot contain failed required checks or merge conflicts`);
      }
    }
  }

  if (matrix.metadata.status === 'blocked_by_merge_conflict') {
    const hasMergeConflictFinding = matrix.findings && matrix.findings.some(f => f.category === 'integration_merge_conflict');
    if (!hasMergeConflictFinding) {
      throw new Error(`Status is 'blocked_by_merge_conflict' but no merge conflict finding is recorded`);
    }
  }

  const ids = new Set();
  if (Array.isArray(matrix.findings)) {
    matrix.findings.forEach((finding, idx) => {
      if (!finding.id) throw new Error(`Missing finding ID at index ${idx}`);
      if (ids.has(finding.id)) throw new Error(`Duplicate finding ID: ${finding.id}`);
      ids.add(finding.id);

      if (!finding.owner || !/^Dev [1234]$/.test(finding.owner)) {
        throw new Error(`Missing or invalid owner in finding ${finding.id}: ${finding.owner}`);
      }

      if (finding.canonicalPort && finding.canonicalPort !== 'N/A') {
        if (finding.canonicalPort.includes('Shadow')) throw new Error(`Shadow validation interface detected in finding ${finding.id}`);
        if (finding.canonicalPort.includes('StateMachine') && finding.owner !== 'Dev 3') throw new Error(`Incorrect runtime owner in finding ${finding.id}`);
        if (finding.canonicalPort.includes('Replay') && finding.owner !== 'Dev 3') throw new Error(`Incorrect replay owner in finding ${finding.id}`);
        if (finding.canonicalPort.includes('EventStore') && finding.owner !== 'Dev 3') throw new Error(`Incorrect event-store owner in finding ${finding.id}`);
      }
    });
  }

  return matrix;
}

function validateProvenance(matrix) {
  const p = join(artifactsDir, 'failure-provenance.json');
  if (!existsSync(p)) {
    throw new Error(`Missing required artifact file: ${p}`);
  }

  let prov;
  try {
    prov = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Malformed JSON in ${p}: ${err.message}`);
  }

  if (!prov || typeof prov !== 'object') {
    throw new Error(`Invalid object in ${p}`);
  }

  validateSha(prov.baseSha, 'baseSha');
  validateSha(prov.integrationDev1Sha, 'integrationDev1Sha');
  validateSha(prov.integrationDev2Sha, 'integrationDev2Sha');
  validateSha(prov.integrationDev3Sha, 'integrationDev3Sha');
  validateSha(prov.integrationDev4Sha, 'integrationDev4Sha');

  // Cross-artifact SHA consistency check
  if (prov.baseSha !== matrix.shas.base) throw new Error(`SHA mismatch between matrix (${matrix.shas.base}) and provenance (${prov.baseSha}) for base`);
  if (prov.integrationDev1Sha !== matrix.shas.dev1) throw new Error(`SHA mismatch for dev1`);
  if (prov.integrationDev2Sha !== matrix.shas.dev2) throw new Error(`SHA mismatch for dev2`);
  if (prov.integrationDev3Sha !== matrix.shas.dev3) throw new Error(`SHA mismatch for dev3`);
  if (prov.integrationDev4Sha !== matrix.shas.dev4) throw new Error(`SHA mismatch for dev4`);

  // Cross-artifact status consistency check
  if (prov.status !== matrix.metadata.status) {
    throw new Error(`Status mismatch between matrix (${matrix.metadata.status}) and provenance (${prov.status})`);
  }

  if (prov.status === 'blocked_by_merge_conflict') {
    if (!Array.isArray(prov.failures) || prov.failures.length === 0) {
      throw new Error(`Provenance status is 'blocked_by_merge_conflict' but failures array is missing or empty`);
    }
    const hasConflict = prov.failures.some(f => f.classification === 'integration_merge_conflict' && f.mergeConflictSha);
    if (!hasConflict) {
      throw new Error(`Provenance status is 'blocked_by_merge_conflict' but no mergeConflictSha is recorded in failures`);
    }
  }

  return prov;
}

try {
  if (!existsSync(artifactsDir)) {
    throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);
  }

  const matrix = validateMatrix();
  const prov = validateProvenance(matrix);
  
  checkNoAbsolutePaths(matrix, 'compatibility-matrix.json');
  checkNoAbsolutePaths(prov, 'failure-provenance.json');

  console.log(`[VALIDATOR] Successfully verified artifact suite for run ${matrix.metadata.runId} with status '${matrix.metadata.status}'.`);
} catch (err) {
  console.error(`[VALIDATOR ERROR] ${err.message}`);
  process.exit(1);
}
