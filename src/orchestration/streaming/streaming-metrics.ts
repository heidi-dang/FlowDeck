export class StreamingMetrics {
  public emitted = 0;
  public persisted = 0;
  public delivered = 0;
  public replayed = 0;
  public duplicated = 0;
  public coalesced = 0;
  public latencies: number[] = [];

  recordLatency(ms: number) {
    this.latencies.push(ms);
  }
}
