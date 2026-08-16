import type { ChildSessionHost } from "../../host-contracts/child-session"

interface OpenCodeSessionNamespace {
  abort?: (input: { sessionId: string }) => Promise<unknown>
  prompt?: (input: { sessionId: string, message: string }) => Promise<unknown>
}

interface OpenCodeClientShape {
  session?: OpenCodeSessionNamespace
}

/**
 * OpenCode implementation of ChildSessionHost.
 * Maps FlowDeck's host-neutral session cancellation and follow-up
 * requests to OpenCode's SDK client.
 */
export class OpenCodeChildSessionHost implements ChildSessionHost {
  constructor(private readonly client: unknown) {}

  async cancel(sessionId: string): Promise<void> {
    const session = (this.client as OpenCodeClientShape | null)?.session
    if (!session?.abort) {
      throw new Error("OPENCODE_SESSION_API_UNAVAILABLE: cannot abort session")
    }
    await session.abort({ sessionId })
  }

  async followup(sessionId: string, prompt: string): Promise<void> {
    const session = (this.client as OpenCodeClientShape | null)?.session
    if (!session?.prompt) {
      throw new Error("OPENCODE_SESSION_API_UNAVAILABLE: cannot prompt session")
    }
    await session.prompt({ sessionId, message: prompt })
  }
}
