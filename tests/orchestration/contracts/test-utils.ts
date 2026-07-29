/**
 * Test utilities for contract domain tests.
 */

import type { Clock } from "@/orchestration/common/ports/clock"
import type { IdGenerator } from "@/orchestration/common/ports/id-generator"

/** Fake clock that returns a fixed timestamp. */
export class FakeClock implements Clock {
  private fixed: Date

  constructor(iso?: string) {
    this.fixed = new Date(iso ?? "2026-07-29T12:00:00Z")
  }

  now(): Date {
    return new Date(this.fixed)
  }

  advance(ms: number): void {
    this.fixed = new Date(this.fixed.getTime() + ms)
  }
}

/** Fake ID generator using an incrementing counter with a prefix. */
export class FakeIdGenerator implements IdGenerator {
  private counter = 0

  constructor(private readonly prefix: string = "test") {}

  generate(): string {
    this.counter++
    return `${this.prefix}-${this.counter}`
  }

  reset(): void {
    this.counter = 0
  }
}
