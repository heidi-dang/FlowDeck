/**
 * Immutable context references for tracking content across versions.
 * @module orchestration/context/context-reference
 */

import { hashContent } from "./content-hasher";

export type ReferenceType = "file" | "symbol" | "segment";

export interface ContextReference {
  readonly id: string;
  readonly type: ReferenceType;
  readonly contentHash: string;
  readonly path?: string;
  readonly range?: Readonly<{ start: number; end: number }>;
  readonly version: string;
  readonly createdAt: Date;
}

export interface ContextReferenceData {
  readonly type: ReferenceType;
  readonly path?: string;
  readonly range?: { start: number; end: number };
  readonly content: string;
  readonly version: string;
}

export class ContextReferenceFactory {
  /**
   * Creates an immutable ContextReference from source data.
   */
  static create(data: ContextReferenceData): ContextReference {
    const id = this.generateId(data);
    return Object.freeze({
      id,
      type: data.type,
      contentHash: hashContent(data.content),
      path: data.path,
      range: data.range ? Object.freeze({ ...data.range }) : undefined,
      version: data.version,
      createdAt: new Date(),
    });
  }

  /**
   * Generates a deterministic ID based on content identity.
   */
  private static generateId(data: ContextReferenceData): string {
    const components = [
      data.type,
      data.path ?? "",
      data.range ? `${data.range.start}:${data.range.end}` : "",
      hashContent(data.content).slice(0, 16),
    ];
    return hashContent(components.join("|")).slice(0, 24);
  }

  /**
   * Returns true if two references point to identical content.
   */
  static equals(a: ContextReference, b: ContextReference): boolean {
    return a.contentHash === b.contentHash && a.type === b.type && a.path === b.path;
  }
}
