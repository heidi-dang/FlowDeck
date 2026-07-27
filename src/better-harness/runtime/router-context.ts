import type { HarnessRuntime } from "./harness-runtime";
import type { RunCoordinator } from "./run-coordinator";
import type { SseManager } from "../transport/sse";

export interface RouterContext {
  runtime: HarnessRuntime;
  coordinator: RunCoordinator;
  resolveProjectPath?: (serverKey: string, projectKey: string) => string | null;
  sseManager?: SseManager;
  authToken?: string;
  bindHost?: string;
  opencodeClient?: unknown;
}
