import type { Run } from "../types/runs"

export interface EnforceRunCreator {
  createRun(input: {
    runType: string
    correlationId: string
    sessionId?: string
    agentId?: string
    metadata?: Record<string, unknown>
  }): Promise<Run>
}

const SOURCE_SHA = /^[0-9a-f]{40}$/

/**
 * Creates the durable orchestration run that execution-plan foreign keys
 * require. OpenCode session ids are correlation data, not orchestration run
 * identities; keeping that distinction prevents plans from being stranded
 * when a session is reused or recreated.
 */
export async function createEnforceRun(
  creator: EnforceRunCreator,
  sessionId: string,
  agentId: string,
  sourceSha: string,
): Promise<Run> {
  if (sessionId.length > 200) throw new Error("ENFORCE_SESSION_ID_LIMIT")
  if (!SOURCE_SHA.test(sourceSha)) throw new Error("ENFORCE_SOURCE_SHA_INVALID")
  return creator.createRun({
    runType: "autonomous-execution",
    correlationId: `flowdeck:enforce:${sessionId || "sessionless"}`,
    sessionId: sessionId || undefined,
    agentId: agentId || undefined,
    metadata: { routingMode: "enforce", sourceSha },
  })
}
