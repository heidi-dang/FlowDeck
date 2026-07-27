import { realpathSync } from "fs";

export interface ProjectRegistration {
  serverKey: string;
  projectKey: string;
  canonicalProjectRoot: string;
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
    if (!resolved.startsWith(canonicalProjectRoot)) {
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
