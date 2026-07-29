import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const artifactsDir = join(process.cwd(), 'artifacts', 'orchestration-compliance');

function validateSha(sha) {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha) || sha === 'unknown') {
    throw new Error(`Invalid SHA: ${sha}`);
  }
}

function validateMatrix() {
  const p = join(artifactsDir, 'compatibility-matrix.json');
  if (!existsSync(p)) return;
  const matrix = JSON.parse(readFileSync(p, 'utf8'));

  if (matrix.schemaVersion !== '1.0') throw new Error('unstable or unsupported schema version');

  const shas = matrix.shas;
  validateSha(shas.base);
  validateSha(shas.dev1);
  validateSha(shas.dev2);
  validateSha(shas.dev3);
  validateSha(shas.dev4);

  const ids = new Set();
  
  if (matrix.findings) {
    matrix.findings.forEach(finding => {
      if (!finding.id) throw new Error('missing failure ID');
      if (ids.has(finding.id)) throw new Error(`duplicate failure ID: ${finding.id}`);
      ids.add(finding.id);

      if (!finding.owner || !/^Dev [1234]$/.test(finding.owner)) {
        throw new Error(`missing owner or invalid owner: ${finding.owner}`);
      }

      if (finding.canonicalPort && finding.canonicalPort !== 'N/A') {
        if (finding.canonicalPort.includes('Shadow')) throw new Error('shadow validation interface detected');
        
        if (finding.canonicalPort.includes('StateMachine') && finding.owner !== 'Dev 3') throw new Error('incorrect runtime owner');
        if (finding.canonicalPort.includes('Replay') && finding.owner !== 'Dev 3') throw new Error('incorrect replay owner');
        if (finding.canonicalPort.includes('EventStore') && finding.owner !== 'Dev 3') throw new Error('incorrect event-store ownership');
        if (finding.canonicalPort.includes('Outbox') && !finding.canonicalPort.includes('Delivery') && finding.owner !== 'Dev 1') throw new Error('unsplit outbox responsibilities (persistence vs delivery)');
      }

      if (finding.evidenceLevel === 'confirmed' && !finding.reproductionCommand && finding.category !== 'integration_merge_conflict') {
        throw new Error('confirmed finding without reproduction command');
      }
    });
  }
  
  console.log('Matrix schema validated.');
}

function validateProvenance() {
  const p = join(artifactsDir, 'failure-provenance.json');
  if (!existsSync(p)) return;
  const prov = JSON.parse(readFileSync(p, 'utf8'));

  validateSha(prov.baseSha);
  validateSha(prov.integrationDev1Sha);
  validateSha(prov.integrationDev2Sha);
  validateSha(prov.integrationDev3Sha);
  validateSha(prov.integrationDev4Sha);
  
  console.log('Provenance schema validated.');
}

try {
  validateMatrix();
  validateProvenance();
  console.log('All orchestration artifacts validated successfully.');
} catch (e) {
  console.error(`Artifact validation failed: ${e.message}`);
  process.exit(1);
}
