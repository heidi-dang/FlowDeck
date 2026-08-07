/**
 * Delta context packets for efficient context updates.
 * @module orchestration/context/delta-context
 */

import { hashContent } from "./content-hasher";
import type { ContextItem } from "./context-deduplicator";

export interface DeltaContextPacket {
  readonly baselineHash: string;
  readonly currentHash: string;
  readonly additions: ContextItem[];
  readonly modifications: ContextItem[];
  readonly deletions: readonly string[];
  readonly unchanged: readonly string[];
}

export interface DeltaContextOptions {
  readonly baselineItems: ContextItem[];
  readonly currentItems: ContextItem[];
}

/**
 * Creates a delta packet describing changes between baseline and current context.
 */
export function createDeltaContextPacket(options: DeltaContextOptions): DeltaContextPacket {
  const { baselineItems, currentItems } = options;

  const baselineMap = new Map(baselineItems.map((i) => [i.id, i]));
  const currentMap = new Map(currentItems.map((i) => [i.id, i]));

  const baselineHash = hashContent(baselineItems.map((i) => i.contentHash).sort().join(","));
  const currentHash = hashContent(currentItems.map((i) => i.contentHash).sort().join(","));

  const additions: ContextItem[] = [];
  const modifications: ContextItem[] = [];
  const deletions: string[] = [];
  const unchanged: string[] = [];

  for (const [id, baselineItem] of baselineMap) {
    const currentItem = currentMap.get(id);
    if (!currentItem) {
      deletions.push(id);
    } else if (currentItem.contentHash !== baselineItem.contentHash) {
      modifications.push(currentItem);
    } else {
      unchanged.push(id);
    }
  }

  for (const [id] of currentMap) {
    if (!baselineMap.has(id)) {
      additions.push(currentMap.get(id)!);
    }
  }

  return Object.freeze({
    baselineHash,
    currentHash,
    additions: Object.freeze([...additions]) as ContextItem[],
    modifications: Object.freeze([...modifications]) as ContextItem[],
    deletions: Object.freeze(deletions),
    unchanged: Object.freeze(unchanged),
  });
}

/**
 * Returns true if the delta packet indicates no changes.
 */
export function isDeltaEmpty(packet: DeltaContextPacket): boolean {
  return (
    packet.additions.length === 0 &&
    packet.modifications.length === 0 &&
    packet.deletions.length === 0
  );
}

/**
 * Returns the count of changed items in a delta packet.
 */
export function getDeltaChangeCount(packet: DeltaContextPacket): number {
  return packet.additions.length + packet.modifications.length + packet.deletions.length;
}
