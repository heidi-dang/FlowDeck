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
  /**
   * Instance-scoped state directory. When set, ALL persistence calls made by
   * the HTTP router are confined to this directory. This guarantees the
   * standalone server never reads or writes canonical (~/.flowdeck/state)
   * harness data, and concurrent instances stay isolated.
   */
  stateDir?: string;
}
