/**
 * FDX Performance Benchmark
 * Benchmarks native Rust FDX vs TypeScript fallback implementations
 */

import { BaseBenchmarkRunner, type BenchmarkResult, type BenchmarkExecution } from '../tests/performance/benchmark-runner';
import { fdxNativeFallbackParityScenario, getNativeExecution, getFallbackExecution } from '../tests/performance/scenarios/fdx-native-fallback-parity';

const BASELINE_SHA = '5809fcf1230ff349ff0d7f5b53ed75403f44573b';
const OUTPUT_DIR = 'benchmark-results';

interface FDXBenchmarkResult {
  iteration: number;
  nativeDuration: number;
  fallbackDuration: number;
  speedupRatio: number;
  parityMaintained: boolean;
}

class FDXBenchmarkRunner extends BaseBenchmarkRunner {
  private fdxResults: FDXBenchmarkResult[] = [];
  private parityThreshold = 90;

  constructor(baselineSha: string) {
    super(baselineSha);
  }

  async runNativeVsFallback(
    iterations: number = 3,
    milestoneIterations: number = 5
  ): Promise<{ baseline: FDXBenchmarkResult[]; milestone: FDXBenchmarkResult[] }> {
    console.log('=== FDX Native vs Fallback Benchmark ===\n');

    // Baseline iterations
    console.log('Running baseline iterations...');
    const baseline = await this.runIterations(iterations, 'baseline');
    
    // Milestone iterations (for comparison)
    console.log('Running milestone iterations...');
    const milestone = await this.runIterations(milestoneIterations, 'milestone');

    return { baseline, milestone };
  }

  private async runIterations(count: number, phase: 'baseline' | 'milestone'): Promise<FDXBenchmarkResult[]> {
    const results: FDXBenchmarkResult[] = [];

    for (let i = 0; i < count; i++) {
      console.log(`  Iteration ${i + 1}/${count}...`);
      
      const [native, fallback] = await Promise.all([
        this.executeWithTiming(getNativeExecution),
        this.executeWithTiming(getFallbackExecution),
      ]);

      const speedupRatio = native.duration > 0 ? fallback.duration / native.duration : 1;
      // Parity maintained if speedup is reasonable (native is faster but not by huge margin)
      const parityMaintained = speedupRatio > 0.5 && speedupRatio < 5;

      const result: FDXBenchmarkResult = {
        iteration: i + 1,
        nativeDuration: Math.round(native.duration * 100) / 100,
        fallbackDuration: Math.round(fallback.duration * 100) / 100,
        speedupRatio: Math.round(speedupRatio * 100) / 100,
        parityMaintained,
      };

      results.push(result);
      this.fdxResults.push(result);
    }

    return results;
  }

  private async executeWithTiming(fn: () => Promise<BenchmarkExecution>): Promise<{ execution: BenchmarkExecution; duration: number }> {
    const start = performance.now();
    const execution = await fn();
    const duration = performance.now() - start + execution.duration;
    return { execution, duration };
  }

  generateReport(): string {
    const lines: string[] = [];
    lines.push('=== FDX Performance Benchmark Report ===');
    lines.push(`Baseline: ${this.baselineSha}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    // Group results by phase
    const baselineResults = this.fdxResults.slice(0, 3);
    const milestoneResults = this.fdxResults.slice(3);

    lines.push('Results:');
    lines.push('');
    lines.push('Iteration | Native (ms) | Fallback (ms) | Speedup | Parity');
    lines.push('----------|-------------|---------------|---------|--------');

    for (const result of this.fdxResults) {
      const iter = String(result.iteration).padStart(8);
      const native = result.nativeDuration.toFixed(2).padStart(11);
      const fallback = result.fallbackDuration.toFixed(2).padStart(13);
      const speedup = result.speedupRatio.toFixed(2).padStart(7);
      const parity = result.parityMaintained ? 'Yes' : 'No';
      lines.push(` ${iter} | ${native} | ${fallback} | ${speedup} | ${parity}`);
    }

    lines.push('');

    // Calculate aggregate statistics
    const nativeDurations = this.fdxResults.map(r => r.nativeDuration);
    const fallbackDurations = this.fdxResults.map(r => r.fallbackDuration);
    const speedups = this.fdxResults.map(r => r.speedupRatio);

    const avgNative = nativeDurations.reduce((a, b) => a + b, 0) / nativeDurations.length;
    const avgFallback = fallbackDurations.reduce((a, b) => a + b, 0) / fallbackDurations.length;
    const avgSpeedup = speedups.reduce((a, b) => a + b, 0) / speedups.length;
    const parityRate = (this.fdxResults.filter(r => r.parityMaintained).length / this.fdxResults.length) * 100;

    lines.push('Aggregate Statistics:');
    lines.push(`  Average Native Duration: ${avgNative.toFixed(2)}ms`);
    lines.push(`  Average Fallback Duration: ${avgFallback.toFixed(2)}ms`);
    lines.push(`  Average Speedup Ratio: ${avgSpeedup.toFixed(2)}x`);
    lines.push(`  Parity Maintenance Rate: ${parityRate.toFixed(1)}%`);

    lines.push('');
    lines.push(`Parity Threshold: ${this.parityThreshold}%`);
    lines.push(`Status: ${parityRate >= this.parityThreshold ? 'PASS' : 'FAIL'}`);

    // Baseline vs Milestone comparison
    if (baselineResults.length > 0 && milestoneResults.length > 0) {
      lines.push('');
      lines.push('Baseline vs Milestone Comparison:');
      
      const baselineAvgSpeedup = baselineResults.reduce((a, r) => a + r.speedupRatio, 0) / baselineResults.length;
      const milestoneAvgSpeedup = milestoneResults.reduce((a, r) => a + r.speedupRatio, 0) / milestoneResults.length;
      const speedupDelta = ((milestoneAvgSpeedup - baselineAvgSpeedup) / baselineAvgSpeedup) * 100;

      lines.push(`  Baseline Avg Speedup: ${baselineAvgSpeedup.toFixed(2)}x`);
      lines.push(`  Milestone Avg Speedup: ${milestoneAvgSpeedup.toFixed(2)}x`);
      lines.push(`  Speedup Delta: ${speedupDelta >= 0 ? '+' : ''}${speedupDelta.toFixed(1)}%`);
    }

    return lines.join('\n');
  }

  getResults(): FDXBenchmarkResult[] {
    return [...this.fdxResults];
  }
}

async function main() {
  const runner = new FDXBenchmarkRunner(BASELINE_SHA);
  
  const baselineIterations = parseInt(process.argv[2] || '3', 10);
  const milestoneIterations = parseInt(process.argv[3] || '5', 10);

  console.log(`Running FDX benchmark: ${baselineIterations} baseline, ${milestoneIterations} milestone iterations\n`);

  const { baseline, milestone } = await runner.runNativeVsFallback(baselineIterations, milestoneIterations);

  const report = runner.generateReport();
  console.log('\n' + report);

  // Save results
  const fs = await import('fs');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(`${OUTPUT_DIR}/fdx-benchmark.txt`, report);
  fs.writeFileSync(`${OUTPUT_DIR}/fdx-benchmark.json`, JSON.stringify(runner.getResults(), null, 2));

  console.log(`\nResults saved to ${OUTPUT_DIR}/`);
}

main().catch(console.error);
