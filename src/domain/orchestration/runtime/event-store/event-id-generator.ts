/**
 * Event ID Generator - Phase 3B
 * 
 * Provides cryptographically-secure and deterministic event ID generation
 */

import { randomUUID } from 'node:crypto';
import type { EventIdGenerator, AppendIdGenerator } from './types.js';
export type { AppendIdGenerator };

/**
 * Default production event ID generator using crypto.randomUUID()
 * 
 * Guarantees uniqueness without relying on Math.random or timestamp collisions
 */
export const defaultEventIdGenerator: EventIdGenerator = (): string => {
  return `evt_${randomUUID()}`;
};

/**
 * Default append ID generator using crypto.randomUUID()
 * Different namespace from event IDs to maintain semantic separation
 */
export const defaultAppendIdGenerator: AppendIdGenerator = (): string => {
  return `append_${randomUUID()}`;
};

/**
 * Create deterministic test ID generators
 */
export function createDeterministicGenerators(
  eventIds: string[],
  appendIds: string[]
): { eventIdGenerator: EventIdGenerator; appendIdGenerator: AppendIdGenerator } {
  let eventIndex = 0;
  let appendIndex = 0;
  
  return {
    eventIdGenerator: () => {
      if (eventIndex >= eventIds.length) throw new Error('Event ID generator sequence exhausted');
      return eventIds[eventIndex++];
    },
    appendIdGenerator: () => {
      if (appendIndex >= appendIds.length) throw new Error('Append ID generator sequence exhausted');
      return appendIds[appendIndex++];
    }
  };
}
