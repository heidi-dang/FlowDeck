export class FaultInjector {
  private activeFaults: Set<string> = new Set();
  
  injectFault(faultName: string): void {
    this.activeFaults.add(faultName);
  }
  
  clearFaults(): void {
    this.activeFaults.clear();
  }
  
  async checkFault(faultName: string): Promise<void> {
    if (this.activeFaults.has(faultName)) {
      throw new Error("Injected fault: " + faultName);
    }
  }
}
