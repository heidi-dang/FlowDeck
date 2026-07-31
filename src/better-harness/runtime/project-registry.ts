import { realpathSync } from "fs";
import path from "path";

export interface ProjectRegistration {
  serverKey: string;
  projectKey: string;
  canonicalProjectRoot: string;
}

export function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

export function isPathContained(allowedRoot: string, candidatePath: string): boolean {
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = normalizePath(realpathSync(allowedRoot));
  } catch {
    throw new Error(`Cannot resolve project root: ${allowedRoot}`);
  }
  try {
    canonicalCandidate = normalizePath(realpathSync(candidatePath));
  } catch {
    throw new Error(`Cannot resolve candidate path: ${candidatePath}`);
  }

  const rel = path.relative(canonicalRoot, canonicalCandidate);

  if (rel === "" || rel === ".") {
    return true;
  }

  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    return false;
  }

  return true;
}

export class ProjectRegistry {
  private registrations = new Map<string, ProjectRegistration>();

  register(registration: ProjectRegistration): void {
    const { serverKey, projectKey, canonicalProjectRoot } = registration;
    let resolved: string;
    try {
      resolved = realpathSync(canonicalProjectRoot);
    } catch {
      throw new Error(`Cannot resolve project root: ${canonicalProjectRoot}`);
    }

    if (!isPathContained(canonicalProjectRoot, resolved)) {
      throw new Error(`Path traversal detected: ${resolved} is outside ${canonicalProjectRoot}`);
    }

    const key = this.makeKey(serverKey, projectKey);
    this.registrations.set(key, { ...registration, canonicalProjectRoot: resolved });
  }

  resolve(serverKey: string, projectKey: string): string | null {
    const key = this.makeKey(serverKey, projectKey);
    return this.registrations.get(key)?.canonicalProjectRoot ?? null;
  }

  unregister(projectKey: string): void {
    for (const [key, reg] of this.registrations) {
      if (reg.projectKey === projectKey) {
        this.registrations.delete(key);
      }
    }
  }

  private makeKey(serverKey: string, projectKey: string): string {
    return `${serverKey}::${projectKey}`;
  }
}
