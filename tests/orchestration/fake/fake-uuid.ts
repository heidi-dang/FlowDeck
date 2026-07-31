export class FakeUuidGenerator {
  private counter: number = 0;
  private prefix: string;
  constructor(prefix: string = 'fake-uuid-') { this.prefix = prefix; }
  generate(): string {
    this.counter++;
    return this.prefix + this.counter.toString().padStart(8, '0');
  }
}
