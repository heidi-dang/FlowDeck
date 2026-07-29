import { describe, it, expect } from 'bun:test';
import { FakeUuidGenerator } from '../fake/fake-uuid';

describe('Contract Compliance Suite', () => {
  it('validates deterministic hashing', () => {
    const generator = new FakeUuidGenerator('hash-');
    expect(generator.generate()).toBe('hash-00000001');
    expect(generator.generate()).toBe('hash-00000002');
  });

  it('validates contract immutability (stub)', () => {
    const contract = { id: '1', state: 'active' };
    const freeze = Object.freeze(contract);
    expect(() => { (freeze as any).state = 'closed'; }).toThrow();
  });
});
