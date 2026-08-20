import type { HarnessRuntime } from "./harness-runtime";
import type { RunCoordinator } from "./run-coordinator";

export interface RouterContext {
  runtime: HarnessRuntime;
  coordinator: RunCoordinator;
  resolveProjectPath?: (serverKey: string, projectKey: string) => string | null;
  authToken?: string;
  bindHost?: string;
  opencodeClient?: unknown;
}
