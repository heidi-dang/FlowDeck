// @ts-nocheck
/**
 * P0 Hardening Tests: recovery generation lifecycle & state leak closure
 *
 * Covers:
 * 1. Preflight revalidation at timer execution (provider/tool/child/cancel/user-message races)
 * 2. Complete release of isPendingContinuation on all suppression/cancellation routes (no state leaks)
 * 3. Recovery generation correlation (user prompt ID → specific assistant response)
 * 4. Empty-text provenance / UNKNOWN classification
 * 5. Telemetry emission (exact match, ordered fallback, rejected)
 * 6. Future recovery success after manual user cancellation (no poisoned state)
 * 7. Sync-prompt and orphan generation timeout lifecycle
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { recoveryCoordinator } from "../src/services/recovery-coordinator"
import { updateWatchdogState, getWatchdogState } from "../src/services/heidi-watchdog"
import flowDeckPlugin from "../src/index"

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "fd-harden-"))
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
  return dir
}

function safeCleanupDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}

async function makePlugin(dir: string) {
  const prompts: any[] = []
  const generatedIds: string[] = []
  const telemetryEvents: any[] = []
  let promptCount = 0
  const mockClient = {
    app: { log: async () => {} },
    session: {
      promptAsync: async (args: any) => {
        prompts.push(args)
        promptCount++
        const msgId = `internal-recovery-${promptCount}`
        generatedIds.push(msgId)
        return { data: { id: msgId } }
      },
    },
  }
  const instance = await flowDeckPlugin.server({ directory: dir, client: mockClient as any })
  const unsubTelemetry = recoveryCoordinator.onTelemetry((ev) => {
    telemetryEvents.push(ev)
  })
  const origDispose = instance.dispose
  instance.dispose = async () => {
    unsubTelemetry()
    if (origDispose) await origDispose()
  }
  return { instance, prompts, generatedIds, telemetryEvents, mockClient }
}

// ─── R1: Timer preflight / provider race ────────────────────────────────────
describe("R1 — timer preflight: provider becomes pending before timer fires", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("suppresses the prompt and releases isPendingContinuation when provider becomes pending", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r1-provider"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // Terminal malformed completion — schedules recovery (50ms timer)
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r1", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })

    // Verify recovery was scheduled and isPendingContinuation is true
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // Before the 50ms timer fires: set isPendingProvider = true
    updateWatchdogState(sessionID, { isPendingProvider: true })

    // Wait for timer to fire and attempt submission
    await new Promise((r) => setTimeout(r, 150))

    // Preflight should have caught isPendingProvider, suppressed the prompt,
    // and completely released isPendingContinuation.
    expect(prompts.length).toBe(0)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("CANCELLED")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R2: Timer preflight / tool race ────────────────────────────────────────
describe("R2 — timer preflight: tool becomes pending before timer fires", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("suppresses the prompt and releases isPendingContinuation when tool becomes pending", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r2-tool"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r2", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })

    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // Before the 50ms timer fires: set isPendingTool = true
    updateWatchdogState(sessionID, { isPendingTool: true })

    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(0)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("CANCELLED")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R3: Timer preflight / cancellation ─────────────────────────────────────
describe("R3 — timer preflight: session cancelled before timer fires", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("fires 0 prompts and leaves isPendingContinuation=false when session.error fires during recovery window", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r3-cancel"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // Schedule recovery
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r3", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })

    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // Fire session.error BEFORE the timer fires (Stop pressed at T+10ms while timer is 50ms)
    await instance.event({
      event: {
        type: "session.error",
        properties: { sessionID, error: "Interrupted", info: { id: sessionID, role: "system" } },
      },
    })

    // Wait for timer window to elapse
    await new Promise((r) => setTimeout(r, 200))

    // Timer should have been cancelled by session.error cleanup
    expect(prompts.length).toBe(0)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R4: Timer preflight / manual user message (state leak closure) ──────────
describe("R4 — timer preflight: manual user message supersedes scheduled recovery without state leak", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("immediately releases isPendingContinuation when manual user message arrives and permits future recovery", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r4-manual"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // 1. Schedule recovery (50ms timer)
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r4", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })

    // Verify recovery was scheduled
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // 2. Manual user message arrives before timer fires (T+20ms)
    await instance.event({
      event: {
        type: "chat.message",
        properties: {
          sessionID,
          info: { id: "manual-user-msg-r4", role: "user" },
          parts: [{ type: "text", text: "Actually, please do something different." }],
        },
      },
    })

    // Assert STATE LEAK IS CLOSED IMMEDIATELY: isPendingContinuation must be false now
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    // Wait for timer window to elapse
    await new Promise((r) => setTimeout(r, 200))

    // 0 automatic recovery prompts should have fired
    expect(prompts.length).toBe(0)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("CANCELLED")

    // 3. PROVE FUTURE RECOVERY IS NOT POISONED:
    // A later genuine malformed completion must successfully trigger a new recovery
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r4-later", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t2" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    // New recovery must have successfully executed
    expect(prompts.length).toBe(1)
    expect(prompts[0].body.parts[0].text).toContain("Continue the current task")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R5: Table-Driven Preflight Suppression Cleanup Tests ────────────────────
describe("R5 — table-driven preflight suppression routes all cleanly release state", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  const suppressionCases = [
    { name: "provider_pending", apply: (sessionID: string) => updateWatchdogState(sessionID, { isPendingProvider: true }) },
    { name: "tool_pending", apply: (sessionID: string) => updateWatchdogState(sessionID, { isPendingTool: true }) },
    { name: "child_pending", apply: (sessionID: string) => updateWatchdogState(sessionID, { isPendingChild: true }) },
  ]

  for (const { name, apply } of suppressionCases) {
    it(`suppression route [${name}] releases isPendingContinuation and sends 0 prompts`, async () => {
      const { instance, prompts } = await makePlugin(dir)
      const sessionID = `ses-suppress-${name}`

      await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

      // Schedule recovery
      await instance.event({
        event: {
          type: "message.updated",
          properties: {
            info: { id: `msg-malformed-${name}`, role: "assistant", sessionID, providerID: "test", modelID: "test" },
            parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
          },
        },
      })

      expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

      // Apply suppression condition
      apply(sessionID)

      // Wait for timer
      await new Promise((r) => setTimeout(r, 150))

      // Assert complete cleanup
      expect(prompts.length).toBe(0)
      expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
      expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("CANCELLED")

      if (instance.dispose) await instance.dispose()
      safeCleanupDir(dir)
    })
  }
})

// ─── R6: Empty-text provenance → UNKNOWN, not internal ──────────────────────
describe("R6 — empty-text provenance is UNKNOWN, not internal", () => {
  it("classifyMessage returns unknown_user_event for missing/empty text", () => {
    const sessionID = "ses-r6-empty"
    const kind1 = recoveryCoordinator.classifyMessage(sessionID, undefined, "")
    expect(kind1).toBe("unknown_user_event")

    const kind2 = recoveryCoordinator.classifyMessage(sessionID, undefined, "   ")
    expect(kind2).toBe("unknown_user_event")

    const kind3 = recoveryCoordinator.classifyMessage(sessionID, "some-id", "")
    expect(kind3).toBe("unknown_user_event")

    const kind4 = recoveryCoordinator.classifyMessage(sessionID, "some-id", "Hello world")
    expect(kind4).toBe("manual_user")

    recoveryCoordinator.cancelSession(sessionID)
  })

  it("empty-text event during pending recovery does NOT reset recovery state", async () => {
    const dir = makeTmpDir()
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r6-state"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // Trigger recovery
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r6", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)

    const wStateBefore = getWatchdogState(sessionID)
    const recoveryCountBefore = wStateBefore?.recoveryCount ?? 0

    // User event with empty text
    await instance.event({
      event: {
        type: "chat.message",
        properties: {
          sessionID,
          info: { id: "empty-user-msg", role: "user" },
          parts: [],
        },
      },
    })

    const wStateAfter = getWatchdogState(sessionID)
    expect(wStateAfter?.recoveryCount).toBe(recoveryCountBefore)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R7: ID provenance persistence across lifecycle events ────────────────────
describe("R7 — ID provenance persists across chat.message + message.updated", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("all lifecycle events for the same internal message ID are classified internal", async () => {
    const prompts: any[] = []
    const generatedIds: string[] = []
    let count = 0
    const mockClient = {
      app: { log: async () => {} },
      session: {
        promptAsync: async (args: any) => {
          prompts.push(args)
          count++
          const id = `internal-prov-${count}`
          generatedIds.push(id)
          return { data: { id } }
        },
      },
    }
    const instance = await flowDeckPlugin.server({ directory: dir, client: mockClient as any })
    const sessionID = "ses-r7-id-prov"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r7", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)

    const internalId = generatedIds[0]
    const wStateBefore = getWatchdogState(sessionID)
    const recoveryCountBefore = wStateBefore?.recoveryCount ?? 0

    // chat.message
    await instance.event({
      event: {
        type: "chat.message",
        properties: {
          sessionID,
          info: { id: internalId, role: "user" },
          parts: [{ type: "text", text: "Continue the current task from the last verified execution state and provide a visible progress or completion response." }],
        },
      },
    })

    // message.updated #1
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID,
          info: { id: internalId, role: "user" },
          parts: [{ type: "text", text: "Continue the current task from the last verified execution state and provide a visible progress or completion response." }],
        },
      },
    })

    // message.updated #2
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID,
          info: { id: internalId, role: "user" },
          parts: [{ type: "text", text: "Continue the current task from the last verified execution state and provide a visible progress or completion response." }],
        },
      },
    })

    const wStateAfter = getWatchdogState(sessionID)
    expect(wStateAfter?.recoveryCount).toBe(recoveryCountBefore)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R8: Exact causal parentID correlation & rejection telemetry ─────────────
describe("R8 — assistant response correlation: exact parentID, fallback, and rejection", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("emits recovery_correlation_exact when assistant parentID matches internal prompt ID", async () => {
    const { instance, prompts, generatedIds, telemetryEvents } = await makePlugin(dir)
    const sessionID = "ses-r8-exact"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // Trigger recovery
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r8", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)
    const internalPromptId = generatedIds[0]

    // Assistant response arrives with matching parentID
    const completed = recoveryCoordinator.notifyAssistantTurnTerminal(
      sessionID,
      "assistant-r8-exact",
      internalPromptId
    )
    expect(completed).toBe(true)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    // Check telemetry
    const exactTel = telemetryEvents.find((t) => t.eventName === "recovery_correlation_exact")
    expect(exactTel).toBeDefined()
    expect(exactTel.details.internalPromptId).toBe(internalPromptId)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })

  it("emits recovery_correlation_rejected and does NOT complete generation when parentID is mismatched", async () => {
    const { instance, prompts, generatedIds, telemetryEvents } = await makePlugin(dir)
    const sessionID = "ses-r8-mismatch"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r8-m", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)
    const _internalPromptId = generatedIds[0]

    // Unrelated assistant turn arrives with DIFFERENT parentID
    const rejected = recoveryCoordinator.notifyAssistantTurnTerminal(
      sessionID,
      "unrelated-assistant-turn",
      "wrong-user-prompt-id"
    )
    expect(rejected).toBe(false)
    // Generation must remain RUNNING, isPendingContinuation remains true
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // Check rejection telemetry
    const rejTel = telemetryEvents.find((t) => t.eventName === "recovery_correlation_rejected")
    expect(rejTel).toBeDefined()
    expect(rejTel.details.assistantParentID).toBe("wrong-user-prompt-id")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })

  it("emits recovery_correlation_ordered_fallback when assistant parentID is absent", async () => {
    const { instance, prompts, telemetryEvents } = await makePlugin(dir)
    const sessionID = "ses-r8-fallback"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r8-fb", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)

    // Assistant response arrives with NO parentID (OpenCode SDK omission)
    const completed = recoveryCoordinator.notifyAssistantTurnTerminal(
      sessionID,
      "assistant-r8-fallback",
      undefined
    )
    expect(completed).toBe(true)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    // Check fallback telemetry
    const fbTel = telemetryEvents.find((t) => t.eventName === "recovery_correlation_ordered_fallback")
    expect(fbTel).toBeDefined()

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R9: Duplicate terminal events (idempotent completion) ────────────────────
describe("R9 — duplicate terminal events complete generation exactly once", () => {
  it("completes generation once and second completion is an idempotent no-op", async () => {
    const dir = makeTmpDir()
    const { instance, generatedIds } = await makePlugin(dir)
    const sessionID = "ses-r9-dup"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r9", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    const internalPromptId = generatedIds[0]

    // First terminal event — completes the generation
    const r1 = recoveryCoordinator.notifyAssistantTurnTerminal(sessionID, "assistant-r9", internalPromptId)
    expect(r1).toBe(true)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    // Duplicate terminal event — idempotent no-op
    const r2 = recoveryCoordinator.notifyAssistantTurnTerminal(sessionID, "assistant-r9", internalPromptId)
    expect(r2).toBe(false)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R10: Sync prompt cancellation cleans up state ───────────────────────────
describe("R10 — sync prompt in SUBMITTED_UNCORRELATED state cancels cleanly", () => {
  it("cleans up orphan timer and sets isPendingContinuation=false on cancel", async () => {
    const dir = makeTmpDir()
    let prompts = 0
    const mockClient = {
      app: { log: async () => {} },
      session: {
        // Sync prompt returns undefined
        prompt: () => { prompts++; return undefined },
      },
    }
    const instance = await flowDeckPlugin.server({ directory: dir, client: mockClient as any })
    const sessionID = "ses-r10-sync-cancel"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // First malformed detection -> enters SUBMITTED_UNCORRELATED
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r10", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(prompts).toBe(1)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("SUBMITTED_UNCORRELATED")

    // Manual user cancellation arrives while SUBMITTED_UNCORRELATED
    await instance.event({
      event: {
        type: "chat.message",
        properties: {
          sessionID,
          info: { id: "user-msg-r10", role: "user" },
          parts: [{ type: "text", text: "I am taking over." }],
        },
      },
    })

    // Assert: state is completely cleaned up
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("CANCELLED")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R11: Orphan generation timeout ─────────────────────────────────────────
describe("R11 — orphan generation timeout releases single-flight", () => {
  it("recovery coordinator notifyAssistantTurnProviderError releases isPendingContinuation", async () => {
    const dir = makeTmpDir()
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r11-orphan"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-malformed-r11", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "t" }, { type: "step-finish", reason: "stop" }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(true)

    // Simulate provider error
    const released = recoveryCoordinator.notifyAssistantTurnProviderError(sessionID)
    expect(released).toBe(true)
    expect(getWatchdogState(sessionID)?.isPendingContinuation).toBe(false)
    expect(recoveryCoordinator.getActiveGeneration(sessionID)?.state).toBe("FAILED")

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R12: Screenshot regression ──────────────────────────────────────────────
describe("R12 — original screenshot regression: 0 Continue prompts during healthy work", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("fires 0 continuations during healthy tool-execution sequence", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r12-healthy"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    for (let i = 0; i < 8; i++) {
      updateWatchdogState(sessionID, { isPendingTool: i % 2 === 0 })
      await instance.event({
        event: {
          type: "message.updated",
          properties: {
            info: { id: `msg-active-${i}`, role: "assistant", sessionID, providerID: "test", modelID: "test" },
            parts: [
              { type: "step-start" },
              { type: "reasoning", text: `thinking step ${i}` },
            ],
          },
        },
      })
    }

    await new Promise((r) => setTimeout(r, 200))
    expect(prompts.length).toBe(0)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})

// ─── R13: Genuine malformed terminal → 1 recovery ────────────────────────────
describe("R13 — genuine malformed terminal turn produces exactly 1 recovery", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })

  it("fires exactly 1 recovery for confirmed terminal empty output", async () => {
    const { instance, prompts } = await makePlugin(dir)
    const sessionID = "ses-r13-genuine"

    await instance.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-genuine-terminal", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "deep thinking" },
            { type: "step-finish", reason: "stop" },
          ],
        },
      },
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)
    expect(prompts[0].body.parts[0].text).toContain("Continue the current task")

    // Second identical event → circuit-broken
    await instance.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg-genuine-terminal", role: "assistant", sessionID, providerID: "test", modelID: "test" },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "deep thinking" },
            { type: "step-finish", reason: "stop" },
          ],
        },
      },
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(prompts.length).toBe(1)

    if (instance.dispose) await instance.dispose()
    safeCleanupDir(dir)
  })
})
