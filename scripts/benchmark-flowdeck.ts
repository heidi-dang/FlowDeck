/**
 * FlowDeck Overall Benchmark Runner
 * Runs all benchmark scenarios and generates comparison reports
 */

import { BaseBenchmarkRunner, type BenchmarkResult, type BenchmarkComparison } from '../tests/performance/benchmark-runner';
import { MetricsCollector } from '../tests/performance/metrics-collector';
import { trivialDirectEditScenario } from '../tests/performance/scenarios/trivial-direct-edit';
import { localBugScenario } from '../tests/performance/scenarios/local-bug';
import { ciRepairScenario } from '../tests/performance/scenarios/ci-repair';
import { crossModuleFeatureScenario } from '../tests/performance/scenarios/cross-module-feature';
import { readOnlyAuditScenario } from '../tests/performance/scenarios/read-only-audit';
import { delegatedTaskScenario } from '../tests/performance/scenarios/delegated-task';
import { verificationFailureScenario } from '../tests/performance/scenarios/verification-failure';
import { cancellationScenario } from '../tests/performance/scenarios/cancellation';
import { recoveryScenario } from '../tests/performance/scenarios/recovery';
import { staleShaRejectionScenario } from '../tests/performance/scenarios/stale-sha-rejection';
import { parallelOwnershipConflictScenario } from '../tests/performance/scenarios/parallel-ownership-conflict';

const BASELINE_SHA = '5809fcf1230ff349ff0d7f5b53ed75403f44573b';
const OUTPUT_DIR = 'benchmark-results';

class FlowDeckBenchmarkRunner extends BaseBenchmarkRunner {
  private metricsCollector: MetricsCollector;

  constructor(baselineSha: string) {
    super(baselineSha);
    this.metricsCollector = new MetricsCollector();
  }

  async runBaseline(): Promise<Map<string, BenchmarkResult>> {
    console.log('=== Running FlowDeck Baseline Benchmark ===\n');
    this.metricsCollector.startBenchmark('flowdeck-baseline');
    
    const results = await this.runAllScenarios();
    
    // Save baseline results
    this.saveResultsToFile(`${OUTPUT_DIR}/baseline-${this.baselineSha}.json`);
    
    return results;
  }

  async runCandidate(candidateSha: string): Promise<Map<string, BenchmarkResult>> {
    console.log(`\n=== Running FlowDeck Candidate Benchmark (${candidateSha}) ===\n`);
    this.metricsCollector.startBenchmark(`flowdeck-candidate-${candidateSha}`);
    
    const results = await this.runAllScenarios();
    
    // Save candidate results
    this.saveResultsToFile(`${OUTPUT_DIR}/candidate-${candidateSha}.json`);
    
    return results;
  }

  generateComparisonReport(
    baselineResults: Map<string, BenchmarkResult>,
    candidateResults: Map<string, BenchmarkResult>,
    candidateSha: string
  ): string {
    const lines: string[] = [];
    lines.push('=== FlowDeck Benchmark Comparison Report ===');
    lines.push(`Baseline: ${this.baselineSha}`);
    lines.push(`Candidate: ${candidateSha}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('Environment:');
    lines.push(`  Node: ${process.version}`);
    lines.push(`  Platform: ${process.platform} ${process.arch}`);
    lines.push(`  CPU Cores: ${os.cpus().length}`);
    lines.push('');
    lines.push('Scenario Results:');
    lines.push('');

    let totalRegressions = 0;
    let scenariosChecked = 0;

    for (const [scenarioId, baselineResult] of baselineResults) {
      const candidateResult = candidateResults.get(scenarioId);
      if (!candidateResult) continue;

      scenariosChecked++;
      const comparison = this.compareWithBaseline(scenarioId, candidateResult);

      lines.push(`  ${scenarioId}:`);
      lines.push(`    Median Delta: ${comparison.medianDeltaMs > 0 ? '+' : ''}${comparison.medianDeltaMs.toFixed(2)}ms`);
      lines.push(`    P95 Delta: ${comparison.p95DeltaMs > 0 ? '+' : ''}${comparison.p95DeltaMs.toFixed(2)}ms`);
      lines.push(`    Equivalent Outcome Rate: ${comparison.equivalentOutcomeRate.toFixed(1)}%`);

      if (comparison.regressions.length > 0) {
        lines.push(`    Regressions:`);
        for (const reg of comparison.regressions) {
          lines.push(`      - ${reg.metric}: ${reg.deltaPercent > 0 ? '+' : ''}${reg.deltaPercent.toFixed(1)}% (${reg.severity})`);
          if (reg.severity !== 'none') totalRegressions++;
        }
      } else {
        lines.push(`    Regressions: None`);
      }
      lines.push('');
    }

    lines.push('Summary:');
    lines.push(`  Scenarios Checked: ${scenariosChecked}`);
    lines.push(`  Total Regressions: ${totalRegressions}`);
    lines.push(`  Status: ${totalRegressions === 0 ? 'PASS' : 'FAIL'}`);

    return lines.join('\n');
  }
}

import * as os from 'os';

async function main() {
  const runner = new FlowDeckBenchmarkRunner(BASELINE_SHA);

  // Register all scenarios
  runner.registerScenario(trivialDirectEditScenario);
  runner.registerScenario(localBugScenario);
  runner.registerScenario(ciRepairScenario);
  runner.registerScenario(crossModuleFeatureScenario);
  runner.registerScenario(readOnlyAuditScenario);
  runner.registerScenario(delegatedTaskScenario);
  runner.registerScenario(verificationFailureScenario);
  runner.registerScenario(cancellationScenario);
  runner.registerScenario(recoveryScenario);
  runner.registerScenario(staleShaRejectionScenario);
  runner.registerScenario(parallelOwnershipConflictScenario);

  const iterations = parseInt(process.argv[2] || '3', 10);
  const candidateSha = process.argv[3];

  console.log(`Running ${iterations} iterations per scenario...\n`);

  // Run baseline
  const baselineResults = await runner.runBaseline();

  // Print baseline summary
  console.log('\nBaseline Results Summary:');
  for (const [id, result] of baselineResults) {
    const median = runner['calculateMedian'](result.metrics.durations);
    const successRate = (result.metrics.successCount / result.metrics.iterations * 100).toFixed(1);
    console.log(`  ${id}: median=${median.toFixed(2)}ms, success=${successRate}%`);
  }

  if (candidateSha) {
    // Run candidate and compare
    const candidateResults = await runner.runCandidate(candidateSha);
    
    const report = runner.generateComparisonReport(baselineResults, candidateResults, candidateSha);
    console.log('\n' + report);

    // Save comparison report
    const fs = await import('fs');
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    fs.writeFileSync(`${OUTPUT_DIR}/comparison-${candidateSha}.txt`, report);
    console.log(`\nComparison report saved to ${OUTPUT_DIR}/comparison-${candidateSha}.txt`);
  } else {
    console.log('\nNo candidate SHA provided. Run with: bun run scripts/benchmark-flowdeck.ts <iterations> <candidate-sha>');
  }
}

main().catch(console.error);
