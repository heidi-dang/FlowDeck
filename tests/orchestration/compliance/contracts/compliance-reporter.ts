import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface ComplianceResult {
  port: string;
  implementation: string;
  status: 'compliant' | 'non_compliant';
  missingMethods: string[];
  semanticFailures?: string[];
  testsExecuted: number;
  passed: number;
  failed: number;
  version: string;
  sha: string;
}

const allResults: ComplianceResult[] = [];

export function recordComplianceResult(result: ComplianceResult) {
  allResults.push(result);
  console.log(`[COMPLIANCE] ${result.port} -> ${result.implementation}: ${result.status}`);
}

export function writeComplianceArtifact(filePath: string, dev1Sha: string, dev2Sha: string, dev4Sha: string) {
  const artifact = {
    dev1Sha,
    dev2Sha,
    dev4Sha,
    portsDiscovered: allResults.map(r => r.port),
    adaptersDiscovered: allResults.map(r => r.implementation),
    matrices: allResults
  };
  
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(artifact, null, 2));
}

export async function runContractSuite<T>(
  portName: string,
  implementationName: string,
  sha: string,
  version: string,
  factory: () => T,
  expectedMethods: (keyof T)[],
  tests: (repo: T, recordFailure: (msg: string) => void) => Promise<void>
): Promise<ComplianceResult> {
  const repo = factory();
  const missingMethods: string[] = [];
  
  for (const method of expectedMethods) {
    if (typeof repo[method] !== 'function') {
      missingMethods.push(method as string);
    }
  }

  let testsExecuted = 0;
  let passed = 0;
  let failed = 0;
  const semanticFailures: string[] = [];

  const recordFailure = (msg: string) => {
    semanticFailures.push(msg);
    failed++;
  };

  if (missingMethods.length === 0) {
    try {
      await tests(repo, recordFailure);
      testsExecuted = 1;
      if (failed === 0) passed = 1;
    } catch (e: any) {
      testsExecuted++;
      recordFailure(e.message);
    }
  } else {
    // Cannot run semantic tests if structural compliance is missing
    testsExecuted = 0;
  }

  const result: ComplianceResult = {
    port: portName,
    implementation: implementationName,
    status: missingMethods.length > 0 || semanticFailures.length > 0 ? 'non_compliant' : 'compliant',
    missingMethods,
    semanticFailures: semanticFailures.length > 0 ? semanticFailures : undefined,
    testsExecuted,
    passed,
    failed,
    version,
    sha
  };

  recordComplianceResult(result);
  return result;
}
