/**
 * Large output artifact handling.
 * @module orchestration/context/large-output-handler
 */

import { hashContent } from "./content-hasher";

export type ArtifactSource = "tool" | "model" | "verification";

export interface LargeOutputArtifact {
  readonly id: string;
  readonly hash: string;
  readonly bytes: number;
  readonly source: ArtifactSource;
  readonly summary: string;
  readonly excerpt: string;
  readonly storedAt: string;
  readonly createdAt: Date;
}

export interface LargeOutputArtifactData {
  readonly content: string;
  readonly source: ArtifactSource;
  readonly summary?: string;
  readonly maxExcerptBytes?: number;
}

export interface StorageResult {
  readonly artifact: LargeOutputArtifact;
  readonly storedPath: string;
}

const DEFAULT_MAX_EXCERPT_BYTES = 500;

const ARTIFACT_DIR = ".flowdeck/artifacts";

/**
 * Creates a large output artifact from content.
 */
export function createLargeOutputArtifact(
  id: string,
  data: LargeOutputArtifactData,
): LargeOutputArtifact {
  const hash = hashContent(data.content);
  const bytes = new TextEncoder().encode(data.content).length;
  const maxExcerpt = data.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES;
  const excerpt = data.content.slice(0, maxExcerpt);

  return Object.freeze({
    id,
    hash,
    bytes,
    source: data.source,
    summary: data.summary ?? summarizeContent(data.content),
    excerpt,
    storedAt: `${ARTIFACT_DIR}/${id}.artifact`,
    createdAt: new Date(),
  });
}

/**
 * Returns a short summary of content (first line, max 100 chars).
 */
function summarizeContent(content: string): string {
  const firstLine = content.split("\n")[0];
  return firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;
}

/**
 * Returns true if content exceeds the size threshold.
 */
export function isLargeOutput(content: string, thresholdBytes: number = 10000): boolean {
  return new TextEncoder().encode(content).length > thresholdBytes;
}

/**
 * Returns the size of content in bytes.
 */
export function getContentSize(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * Retrieves a section from artifact content by line range.
 */
export function retrieveArtifactSection(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const lines = content.split("\n");
  return lines.slice(startLine, endLine).join("\n");
}

/**
 * Returns a preview of artifact content (first N lines).
 */
export function getArtifactPreview(content: string, maxLines: number = 20): string {
  const lines = content.split("\n");
  const preview = lines.slice(0, maxLines);
  const truncated = preview.join("\n");
  return lines.length > maxLines ? truncated + "\n..." : truncated;
}
