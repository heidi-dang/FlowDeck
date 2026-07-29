export class ConcurrencyHarness {
  static async runConcurrent(tasks: (() => Promise<any>)[], concurrency: number = tasks.length): Promise<any[]> {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const chunk = tasks.slice(i, i + concurrency);
      results.push(...await Promise.all(chunk.map(t => t())));
    }
    return results;
  }
  
  static createBarrier(count: number): { wait: () => Promise<void>, signal: () => void } {
    let current = 0;
    let resolve: () => void;
    const promise = new Promise<void>((r) => resolve = r);
    return {
      wait: () => promise,
      signal: () => {
        current++;
        if (current >= count) resolve();
      }
    };
  }
}
