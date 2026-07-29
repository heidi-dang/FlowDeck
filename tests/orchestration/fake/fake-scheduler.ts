export type Task = () => Promise<void>;
export class DeterministicScheduler {
  private queue: Task[] = [];
  schedule(task: Task): void { this.queue.push(task); }
  async runNext(): Promise<boolean> {
    const task = this.queue.shift();
    if (task) { await task(); return true; }
    return false;
  }
  async flush(): Promise<void> {
    while (await this.runNext()) {}
  }
}
