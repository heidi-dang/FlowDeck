/**
 * Evidence-only descent validator.
 *
 * Validates that the diff between a benchmarked implementation commit and the current
 * HEAD contains ONLY explicitly allow-listed generated artifact files.
 *
 * Allow-list:  artifacts/**
 * Block-list:  src/**, tests/**, scripts/**, .github/**, docs/**, crates/**,
 *              package.json, package-lock.json, bun.lock, Cargo.lock, tsconfig.json, etc.
 *
 * An artifact-only descendant is acceptable when all changes are allow-listed.
 * Any source, test, config, or workflow change after the benchmark SHA requires regeneration.
 */
import { execSync } from 'child_process';

export interface EvidenceDescentResult {
  valid: boolean;
  reason: string;
  implSha: string;
  headSha: string;
  /** Files changed between implSha and headSha, empty if exact match */
  changedFiles: string[];
  /** Files that are NOT in the allow-list, empty on valid */
  blockedFiles: string[];
}

/** Path prefixes that must not change after benchmark generation without regeneration. */
const BLOCKED_PREFIXES = [
  'src/',
  'tests/',
  'scripts/',
  '.github/',
  'docs/',
  'crates/',
];

const BLOCKED_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'bun.lock',
  'Cargo.lock',
  'Cargo.toml',
  'tsconfig.json',
  'tsconfig.build.json',
  '.oxlintrc.json',
]);

/** Returns true when a file is explicitly allowed in an evidence-only descendant commit. */
function isAllowedEvidenceFile(file: string): boolean {
  return file.startsWith('artifacts/');
}

function _isBlockedFile(file: string): boolean {
  if (BLOCKED_EXACT.has(file)) return true;
  return BLOCKED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * Validate that the diff between implSha and headSha is evidence-only.
 *
 * @param implSha - The SHA at which benchmarks were generated (must be 40-char hex)
 * @param headSha - The current HEAD SHA (must be 40-char hex)
 * @param cwd     - Optional working directory (defaults to process.cwd())
 */
export function validateEvidenceOnlyDescent(
  implSha: string,
  headSha: string,
  cwd: string = process.cwd()
): EvidenceDescentResult {
  const exec = (cmd: string) => execSync(cmd, { encoding: 'utf-8', cwd }).trim();

  // 1. Validate SHA format — full 40-char hex required, abbreviations rejected
  if (!implSha || !/^[0-9a-f]{40}$/i.test(implSha)) {
    return {
      valid: false,
      reason: `Invalid or abbreviated implSha: '${implSha}'. Must be a full 40-character hex SHA.`,
      implSha,
      headSha,
      changedFiles: [],
      blockedFiles: [],
    };
  }

  if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return {
      valid: false,
      reason: `Invalid or abbreviated headSha: '${headSha}'. Must be a full 40-character hex SHA.`,
      implSha,
      headSha,
      changedFiles: [],
      blockedFiles: [],
    };
  }

  // 2. Exact match — trivially valid
  if (implSha === headSha) {
    return { valid: true, reason: 'Exact SHA match.', implSha, headSha, changedFiles: [], blockedFiles: [] };
  }

  // 3. Verify implSha is a reachable ancestor of headSha
  try {
    exec(`git merge-base --is-ancestor ${implSha} ${headSha}`);
  } catch {
    return {
      valid: false,
      reason: `implSha (${implSha}) is not a reachable ancestor of headSha (${headSha}).`,
      implSha,
      headSha,
      changedFiles: [],
      blockedFiles: [],
    };
  }

  // 4. Enumerate files changed between implSha and headSha
  let changedFiles: string[] = [];
  try {
    const raw = exec(`git diff --name-only ${implSha}..${headSha}`);
    changedFiles = raw.split('\n').filter(Boolean);
  } catch {
    return {
      valid: false,
      reason: 'Could not enumerate files changed between implSha and headSha.',
      implSha,
      headSha,
      changedFiles: [],
      blockedFiles: [],
    };
  }

  if (changedFiles.length === 0) {
    return { valid: true, reason: 'No files changed between implSha and headSha.', implSha, headSha, changedFiles: [], blockedFiles: [] };
  }

  // 5. Classify each changed file
  const blockedFiles = changedFiles.filter((f) => !isAllowedEvidenceFile(f));

  if (blockedFiles.length > 0) {
    return {
      valid: false,
      reason: `Evidence-only descent rejected: non-artifact files changed after benchmark SHA: ${blockedFiles.join(', ')}`,
      implSha,
      headSha,
      changedFiles,
      blockedFiles,
    };
  }

  return {
    valid: true,
    reason: 'All changes between implSha and headSha are allow-listed evidence artifacts.',
    implSha,
    headSha,
    changedFiles,
    blockedFiles: [],
  };
}
