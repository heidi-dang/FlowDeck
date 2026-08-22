/**
 * FlowDeck Path Containment Primitive
 *
 * Enforces strict filesystem containment boundaries to prevent path traversal,
 * symlink escapes, prefix collisions, and absolute path overrides across
 * .codebase, FDX daemon, and FDX native fallbacks.
 */

import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export class PathTraversalError extends Error {
  readonly code = "PATH_TRAVERSAL_DETECTED"
  constructor(message: string) {
    super(message)
    this.name = "PathTraversalError"
  }
}

/**
 * Normalizes Windows & Unix separators and detects raw dangerous patterns.
 */
function sanitizeInput(rawPath: string): string {
  if (typeof rawPath !== "string") {
    throw new PathTraversalError("Path must be a string")
  }
  if (rawPath.includes("\0")) {
    throw new PathTraversalError("Path contains NUL byte")
  }
  return rawPath
}

/**
 * Checks if a relative path escapes its root (lexical check).
 */
function isLexicallyEscaped(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)
}

/**
 * Resolves canonical path of an existing root directory.
 */
export function getCanonicalRoot(root: string): string {
  sanitizeInput(root)
  const resolved = resolve(root)
  if (existsSync(resolved)) {
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  return resolved
}

export interface ContainmentOptions {
  /** Reject absolute input paths even if they point inside the root */
  forbidAbsoluteInput?: boolean
  /** Whether the target path must already exist on disk */
  mustExist?: boolean
  /** For write operations: verify that existing ancestor directories do not escape via symlink */
  forWrite?: boolean
}

/**
 * Safely resolves and asserts that `userPath` stays within `rootDir`.
 *
 * Throws `PathTraversalError` on any containment violation or invalid input.
 */
export function resolveContainedPath(
  rootDir: string,
  userPath: string,
  options: ContainmentOptions = {}
): string {
  sanitizeInput(userPath)
  if (!userPath.trim()) {
    throw new PathTraversalError("Path cannot be empty")
  }

  // Windows drive letter check on relative inputs (e.g., "C:foo" or "D:\\bar")
  if (options.forbidAbsoluteInput) {
    if (isAbsolute(userPath) || /^[a-zA-Z]:/.test(userPath) || userPath.startsWith("\\\\") || userPath.startsWith("//")) {
      throw new PathTraversalError(`Absolute paths are not permitted: "${userPath}"`)
    }
  }

  const canonicalRoot = getCanonicalRoot(rootDir)

  // Standardize Windows-style backslashes for path resolution if not on Windows
  const normalizedUserPath = userPath.replace(/\\/g, sep)
  const candidate = resolve(canonicalRoot, normalizedUserPath)

  // 1. Lexical containment check against canonical root
  const rel = relative(canonicalRoot, candidate)
  if (isLexicallyEscaped(rel)) {
    throw new PathTraversalError(`Path "${userPath}" escapes repository jail "${rootDir}"`)
  }

  // 2. Symlink & physical containment check
  if (existsSync(candidate)) {
    try {
      const realCandidate = realpathSync(candidate)
      const realRel = relative(canonicalRoot, realCandidate)
      if (isLexicallyEscaped(realRel)) {
        throw new PathTraversalError(`Symlink target "${realCandidate}" escapes repository jail "${rootDir}"`)
      }
      return realCandidate
    } catch (err: any) {
      if (err instanceof PathTraversalError) throw err
      throw new PathTraversalError(`Failed to resolve real path for "${userPath}": ${err.message}`)
    }
  }

  if (options.mustExist) {
    throw new PathTraversalError(`Path does not exist: "${userPath}"`)
  }

  // 3. For non-existent files or writes: check closest existing ancestor directory inside canonicalRoot for symlink escape
  let ancestor = dirname(candidate)
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor) && !isLexicallyEscaped(relative(canonicalRoot, ancestor))) {
    ancestor = dirname(ancestor)
  }

  if (existsSync(ancestor) && !isLexicallyEscaped(relative(canonicalRoot, ancestor))) {
    try {
      const realAncestor = realpathSync(ancestor)
      const realAncestorRel = relative(canonicalRoot, realAncestor)
      if (isLexicallyEscaped(realAncestorRel)) {
        throw new PathTraversalError(`Parent directory symlink escapes repository jail "${rootDir}"`)
      }
    } catch (err: any) {
      if (err instanceof PathTraversalError) throw err
      throw new PathTraversalError(`Failed to resolve ancestor path: ${err.message}`)
    }
  }

  return candidate
}

/**
 * Helper to check if a path is safely contained without throwing.
 */
export function isPathContained(
  rootDir: string,
  userPath: string,
  options: ContainmentOptions = {}
): boolean {
  try {
    resolveContainedPath(rootDir, userPath, options)
    return true
  } catch {
    return false
  }
}

/**
 * Specifically resolves and jails paths inside `<workspace>/.codebase/`.
 */
export function resolveCodebasePath(
  workspaceDir: string,
  filename: string,
  options: { forWrite?: boolean; mustExist?: boolean } = {}
): string {
  sanitizeInput(filename)
  if (!filename.trim()) {
    throw new PathTraversalError("Codebase filename cannot be empty")
  }

  // Strict check: codebase filenames must be relative
  if (isAbsolute(filename) || /^[a-zA-Z]:/.test(filename) || filename.startsWith("\\\\") || filename.startsWith("//")) {
    throw new PathTraversalError(`Absolute paths are not permitted in .codebase: "${filename}"`)
  }

  const canonicalWorkspace = getCanonicalRoot(workspaceDir)
  const codebaseRoot = resolve(canonicalWorkspace, ".codebase")

  // Jailed strictly within <workspace>/.codebase
  return resolveContainedPath(codebaseRoot, filename, {
    forbidAbsoluteInput: true,
    mustExist: options.mustExist,
    forWrite: options.forWrite,
  })
}
