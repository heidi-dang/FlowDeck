import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { validateHistorySafety, sanitizeReasoningOnlyHistory } from "../src/services/provider-history-safety"
import type { Message, Part } from "@opencode-ai/sdk"

describe("Heidi Reasoning Recovery & Replay Safety", () => {
  it("prevents HTTP 400 INVALID_ARGUMENT by converting empty/reasoning-only payload to provider-safe history", () => {
    // 1. Exact reproduction fixture:
    // user: "Implement Phase 8"
    // assistant: tool call bash
    // tool result: npm tests pass
    // assistant: step-start, reasoning(non-empty), step-finish(reason=stop), no text, no tool call
    // user: "Why you stop"
    const messages = [
      {
        info: { id: "msg_1", role: "user", sessionID: "ses_123" } as Message,
        parts: [{ type: "text", text: "Implement Phase 8" }] as Part[]
      },
      {
        info: { id: "msg_2", role: "assistant", sessionID: "ses_123" } as Message,
        parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }] as Part[]
      },
      {
        info: { id: "msg_3", role: "assistant", sessionID: "ses_123" } as Message,
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "Internal thought process..." },
          { type: "step-finish", reason: "stop" }
        ] as Part[]
      },
      {
        info: { id: "msg_4", role: "user", sessionID: "ses_123" } as Message,
        parts: [{ type: "text", text: "Why you stop" }] as Part[]
      }
    ]

    // Validate history before sanitation
    const initialDiag = validateHistorySafety(messages)
    expect(initialDiag.safe).toBe(false)
    expect(initialDiag.issues).toContain("REASONING_ONLY_ASSISTANT")

    // Sanitize for replay
    const sanitized = sanitizeReasoningOnlyHistory(messages)

    // Verify sanitized structure
    const targetTurn = sanitized.find(m => m.info.id === "msg_3")
    expect(targetTurn).toBeDefined()
    
    // Must contain safe visible placeholder
    const textPart = targetTurn?.parts.find(p => p.type === "text")
    expect(textPart).toBeDefined()
    expect((textPart as any)?.text).toBe("[Previous assistant turn completed without visible output.]")

    // Hidden reasoning text must NOT be exposed or duplicated into text part
    expect((textPart as any)?.text).not.toContain("Internal thought process...")

    // Validate history after sanitation -> must be safe
    const finalDiag = validateHistorySafety(sanitized)
    expect(finalDiag.safe).toBe(true)
    expect(finalDiag.issues).toHaveLength(0)
  })
})

import flowDeckPlugin from "../src/index"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"

describe("Heidi Reasoning Recovery Runtime Integration", () => {
  let tmpDir: string
  let pluginInstance: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-test-reasoning-"))
    writeFileSync(join(tmpDir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
    pluginInstance = null
  })

  afterEach(async () => {
    if (pluginInstance?.dispose) {
      try { await pluginInstance.dispose() } catch {}
    }
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it("triggers bounded continuation exactly once per signature on reasoning-only stops", async () => {
    let prompts: any[] = []
    
    const mockClient = {
      app: { log: async () => {} },
      session: {
        promptAsync: async (args: any) => {
          prompts.push(args)
        }
      }
    }
    
    pluginInstance = (await (flowDeckPlugin as any).server({ directory: tmpDir, client: mockClient as any })) as any
    const sessionID = "ses_reasoning_1"
    
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } }
    })
    
    // Simulate reasoning-only message
    const msgParts = [
      { type: "reasoning", text: "thinking..." },
      { type: "step-finish", reason: "stop" }
    ]
    const msgInfo = { id: "msg_malformed_1", role: "assistant", sessionID, providerID: "test_prov", modelID: "test_model" }
    
    await pluginInstance["event"]({
      event: {
        type: "message.updated",
        properties: { info: msgInfo, parts: msgParts }
      }
    })
    
    // Wait for async setTimeout prompt
    await new Promise(r => setTimeout(r, 100))
    
    expect(prompts.length).toBe(1)
    expect(prompts[0].path.id).toBe(sessionID)
    expect(prompts[0].body.parts[0].text).toContain("Continue the current task")
    
    // Send exact same signature again -> circuit breaker should fire, no continuation
    await pluginInstance["event"]({
      event: {
        type: "message.updated",
        properties: { info: msgInfo, parts: msgParts }
      }
    })
    
    await new Promise(r => setTimeout(r, 100))
    
    expect(prompts.length).toBe(1) // Still 1
    
    // Send a normal completion -> no continuation
    const normalMsgParts = [
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "Here you go!" },
      { type: "step-finish", reason: "stop" }
    ]
    const normalMsgInfo = { id: "msg_normal_2", role: "assistant", sessionID, providerID: "test_prov", modelID: "test_model" }
    
    await pluginInstance["event"]({
      event: {
        type: "message.updated",
        properties: { info: normalMsgInfo, parts: normalMsgParts }
      }
    })
    
    await new Promise(r => setTimeout(r, 100))
    expect(prompts.length).toBe(1) // Still 1
  })
})

describe("Heidi Reasoning Recovery — bounded stage-2 on provider 400", () => {
  let tmpDir2: string
  let pluginInstance2: any
  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "fd-test-reasoning2-"))
    writeFileSync(join(tmpDir2, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
  })
  afterEach(async () => {
    if (pluginInstance2?.dispose) { try { await pluginInstance2.dispose() } catch {} }
    rmSync(tmpDir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it("promotes a failed stage-1 continuation (400 INVALID_ARGUMENT) to exactly one bounded stage-2 recovery and stops", async () => {
    let prompts: any[] = []
    const mockClient = {
      app: { log: async () => {} },
      session: {
        promptAsync: async (args: any) => { prompts.push(args) },
      },
    }
    pluginInstance2 = (await (flowDeckPlugin as any).server({ directory: tmpDir2, client: mockClient as any })) as any
    const sessionID = "ses_reasoning_stage2"
    await pluginInstance2["event"]({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    const msgParts = composeReasoningOnly([
      { type: "reasoning", text: "thinking..." },
      { type: "step-finish", reason: "stop" },
    ])
    const msgInfo = { id: "msg_malformed_state2", role: "assistant", sessionID, providerID: "heidi", modelID: "heidi-antigravity" }

    // 1. Reasoning-only completion -> stage-1 continuation (fires once even on duplicate event delivery)
    await pluginInstance2["event"]({ event: { type: "message.updated", properties: { info: msgInfo, parts: msgParts } } })
    await pluginInstance2["event"]({ event: { type: "session.idle", properties: { info: msgInfo, parts: msgParts } } })
    await new Promise(r => setTimeout(r, 120))
    expect(prompts.length).toBe(1)

    // 2. Stage-1 continuation fails with 400 INVALID_ARGUMENT (message carries error)
    const failedInfo = { ...msgInfo, id: "msg_failed_state2", error: new Error("AI_APICallError: [antigravity/gemini-3.6-flash-high] [400]: {\"status\": \"INVALID_ARGUMENT\"}") }
    await pluginInstance2["event"]({ event: { type: "message.updated", properties: { info: failedInfo } } })
    await new Promise(r => setTimeout(r, 120))
    expect(prompts.length).toBe(2)

    // 3. Stage-2 also fails with 400 -> recovery exhausted, no further continuation
    const failedInfo2 = { ...msgInfo, id: "msg_failed2_state2", error: new Error("AI_APICallError: [antigravity/gemini-3.6-flash-high] [400]: {\"status\": \"INVALID_ARGUMENT\"}") }
    await pluginInstance2["event"]({ event: { type: "message.updated", properties: { info: failedInfo2 } } })
    await new Promise(r => setTimeout(r, 120))
    expect(prompts.length).toBe(2)
  })

  it("does NOT retry when a continuation fails with a non-replay error (no stage-2 promotion)", async () => {
    let prompts: any[] = []
    const mockClient = {
      app: { log: async () => {} },
      session: { promptAsync: async (args: any) => { prompts.push(args) } },
    }
    pluginInstance2 = (await (flowDeckPlugin as any).server({ directory: tmpDir2, client: mockClient as any })) as any
    const sessionID = "ses_reasoning_no_stage2"
    await pluginInstance2["event"]({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })
    const msgInfo = { id: "msg_a", role: "assistant", sessionID, providerID: "heidi", modelID: "heidi-antigravity" }
    await pluginInstance2["event"]({ event: { type: "message.updated", properties: { info: msgInfo, parts: composeReasoningOnly([{ type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }]) } } })
    await new Promise(r => setTimeout(r, 100))
    expect(prompts.length).toBe(1)
    const failedInfo = { ...msgInfo, id: "msg_b", error: new Error("Rate limit exceeded") }
    await pluginInstance2["event"]({ event: { type: "message.updated", properties: { info: failedInfo } } })
    await new Promise(r => setTimeout(r, 100))
    expect(prompts.length).toBe(1)
  })
})

function composeReasoningOnly(parts: any[]): any[] {
  return [{ type: "step-start" }, ...parts]
}
