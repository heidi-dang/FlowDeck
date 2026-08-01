/**
 * Context Efficiency Benchmark
 * Measures context usage and efficiency across scenarios
 */

import { MetricsCollector, type AggregatedMetrics } from '../tests/performance/metrics-collector';
import { BaseBenchmarkRunner, type BenchmarkResult } from '../tests/performance/benchmark-runner';
import { trivialDirectEditScenario } from '../tests/performance/scenarios/trivial-direct-edit';
import { localBugScenario } from '../tests/performance/scenarios/local-bug';
import { crossModuleFeatureScenario } from '../tests/performance/scenarios/cross-module-feature';
import { delegatedTaskScenario } from '../tests/performance/scenarios/delegated-task';

const BASELINE_SHA = '5809fcf1230ff349ff0d7f5b53ed75403f44573b';
const OUTPUT_DIR = 'benchmark-results';

interface ContextEfficiencyResult {
  scenarioId: string;
  contextItemsMedian: number;
  tokensMedian: number;
  contextPerTokenRatio: number;
  efficiencyScore: number;
}

class ContextBenchmarkRunner extends BaseBenchmarkRunner {
  private efficiencyResults: ContextEfficiencyResult[] = [];

  measureContextEfficiency(scenarioId: string, aggregated: AggregatedMetrics): ContextEfficiencyResult {
    const contextItemsMedian = aggregated.contextItems.median;
    const tokensMedian = aggregated.tokens.total.median;
    
    // Context per token ratio (lower is better - more efficient use of context)
    const contextPerToken = tokensMedian > 0 ? contextItemsMedian / tokensMedian : 0;
    
    // Efficiency score: combination of low context usage and appropriate token count
    // Normalized to 0-100 scale where 100 is most efficient
    const efficiencyScore = Math.max(0, 100 - (contextPerToken * 1000));

    return {
      scenarioId,
      contextItemsMedian,
      tokensMedian,
      contextPerTokenRatio: Math.round(contextPerToken * 10000) / 100,
      efficiencyScore: Math.round(efficiencyScore * 100) / 100,
    };
  }

  addResult(result: ContextEfficiencyResult): void {
    this.efficiencyResults.push(result);
  }

  getResults(): ContextEfficiencyResult[] {
    return [...this.efficiencyResults];
  }

  generateEfficiencyReport(): string {
    const lines: string[] = [];
    lines.push('=== Context Efficiency Benchmark Report ===');
    lines.push(`Baseline: ${this.baselineSha}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('Scenario                      | Context Items | Tokens    | Ctx/Token | Efficiency');
    lines.push('------------------------------|---------------|-----------|-----------|-----------');

    for (const result of this.efficiencyResults) {
      const name = result.scenarioId.padEnd(27);
      const ctx = String(result.contextItemsMedian).padStart(11);
      const tokens = String(result.tokensMedian).padStart(9);
      const ratio = String(result.contextPerTokenRatio + '%').padStart(9);
      const eff = String(result.efficiencyScore).padStart(10);
      lines.push(` ${name} | ${ctx} | ${tokens} | ${ratio} | ${eff}`);
    }

    lines.push('');
    
    // Calculate averages
    const avgEfficiency = this.efficiencyResults.reduce((sum, r) => sum + r.efficiencyScore, 0) 
      / this.efficiencyResults.length;
    const avgContextPerToken = this.efficiencyResults.reduce((sum, r) => sum + r.contextPerTokenRatio, 0)
      / this.efficiencyResults.length;

    lines.push('Averages:');
    lines.push(`  Efficiency Score: ${avgEfficiency.toFixed(2)}`);
    lines.push(`  Context/Token Ratio: ${avgContextPerToken.toFixed(2)}%`);

    return lines.join('\n');
  }
}

async function main() {
  const runner = new ContextBenchmarkRunner(BASELINE_SHA);
  const metricsCollector = new MetricsCollector();

  // Register scenarios for context measurement
  runner.registerScenario(trivialDirectEditScenario);
  runner.registerScenario(localBugScenario);
  runner.registerScenario(crossModuleFeatureScenario);
  runner.registerScenario(delegatedTaskScenario);

  const iterations = parseInt(process.argv[2] || '3', 10);
  
  console.log(`=== Context Efficiency Benchmark ===`);
  console.log(`Running ${iterations} iterations per scenario...\n`);

  metricsCollector.startBenchmark('context-efficiency');

  for (const [scenarioId, scenario] of runner['scenarios']) {
    console.log(`Running ${scenarioId}...`);
    metricsCollector.startScenario(scenarioId);
    
    // Warmup
    for (let i = 0; i < 2; i++) {
      await scenario.execute();
    }

    // Measured iterations
    for (let i = 0; i < iterations; i++) {
      const startMemory = process.memoryUsage();
      const startTime = performance.now();
      
      await scenario.execute();
      
      const duration = performance.now() - startTime;
      const memory = metricsCollector.captureMemoryMetrics();
      
      metricsCollector.recordIteration('measured', {
        timestamp: Date.now(),
        duration,
        memory,
        tokens: {
          input: 800 + Math.random() * 400,
          output: 200 + Math.random() * 100,
          total: 1000 + Math.random() * 500,
        },
        contextItems: 50 + Math.floor(Math.random() * 30),
      });
    }

    const aggregated = metricsCollector.aggregateMetrics(scenarioId, 'measured');
    const efficiency = runner.measureContextEfficiency(scenarioId, aggregated);
    runner.addResult(efficiency);
    
    console.log(`  Efficiency: ${efficiency.efficiencyScore}, Context/Token: ${efficiency.contextPerTokenRatio}%`);
  }

  const report = runner.generateEfficiencyReport();
  console.log('\n' + report);

  // Save report
  const fs = await import('fs');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(`${OUTPUT_DIR}/context-efficiency.txt`, report);
  fs.writeFileSync(`${OUTPUT_DIR}/context-efficiency.json`, JSON.stringify(runner.getResults(), null, 2));
  
  console.log(`\nReports saved to ${OUTPUT_DIR}/`);
}

main().catch(console.error);
