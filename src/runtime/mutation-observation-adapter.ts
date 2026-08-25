/**
 * MutationObservationAdapter — Normalized mutation target extraction and content-derived fingerprinting.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export interface MutationTargets {
  kind: "single" | "multi" | "unknown";
  targetPaths: string[];
  canFingerprintPrecisely: boolean;
}

export function extractMutationTargets(
  tool: string,
  args?: Record<string, unknown> | null
): MutationTargets {
  if (!args || typeof args !== "object") {
    return { kind: "unknown", targetPaths: [], canFingerprintPrecisely: false };
  }

  const mutatingTools = new Set(["write", "edit", "patch", "apply_patch", "delete_file", "rm"]);
  if (!mutatingTools.has(tool)) {
    return { kind: "unknown", targetPaths: [], canFingerprintPrecisely: false };
  }

  const paths: string[] = [];

  const directPath = args.file ?? args.filePath ?? args.path ?? args.targetPath;
  if (typeof directPath === "string" && directPath.trim().length > 0) {
    paths.push(directPath.trim());
  }

  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === "string" && f.trim().length > 0) {
        paths.push(f.trim());
      }
    }
  }

  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string" && p.trim().length > 0) {
        paths.push(p.trim());
      }
    }
  }

  // Check for patch content containing unified diff headers (--- a/file +++ b/file)
  const patchContent = args.patch ?? args.diff ?? args.patchContent;
  if (typeof patchContent === "string") {
    const diffHeaderRegex = /^(?:---|\+\+\+)\s+[ab]\/(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = diffHeaderRegex.exec(patchContent)) !== null) {
      const p = match[1]?.trim();
      if (p && p !== "/dev/null" && !paths.includes(p)) {
        paths.push(p);
      }
    }
  }

  const uniquePaths = Array.from(new Set(paths));
  if (uniquePaths.length === 0) {
    return { kind: "unknown", targetPaths: [], canFingerprintPrecisely: false };
  }

  return {
    kind: uniquePaths.length === 1 ? "single" : "multi",
    targetPaths: uniquePaths,
    canFingerprintPrecisely: true,
  };
}

/**
 * Validate that a relative path stays within project containment.
 */
export function isPathContained(projectRoot: string, targetPath: string): boolean {
  const root = resolve(projectRoot);
  const full = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  const rel = relative(root, full);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Content-derived path fingerprint: existence + content sha256.
 */
export function getSinglePathContentFingerprint(projectRoot: string, targetPath: string): string {
  try {
    if (!isPathContained(projectRoot, targetPath)) {
      return "out_of_containment";
    }
    const full = isAbsolute(targetPath) ? resolve(targetPath) : resolve(projectRoot, targetPath);
    if (!existsSync(full)) {
      return "missing";
    }
    const buf = readFileSync(full);
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    return `content:${buf.length}:${hash}`;
  } catch {
    return "err";
  }
}

/**
 * Fingerprint a set of target paths deterministically.
 */
export function getMutationTargetFingerprint(projectRoot: string, targetPaths: string[]): string {
  if (targetPaths.length === 0) return "none";
  const sorted = [...targetPaths].sort();
  const parts = sorted.map(p => `${p}=${getSinglePathContentFingerprint(projectRoot, p)}`);
  return createHash("sha256").update(parts.join(";")).digest("hex").slice(0, 16);
}
