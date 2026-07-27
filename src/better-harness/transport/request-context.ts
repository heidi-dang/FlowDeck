export interface RequestContext {
  projectId: string;
  runId?: string;
}

let currentContext: RequestContext | null = null;

export function setRequestContext(ctx: RequestContext): void {
  currentContext = ctx;
}

export function getRequestContext(): RequestContext | null {
  return currentContext;
}

export function clearRequestContext(): void {
  currentContext = null;
}
