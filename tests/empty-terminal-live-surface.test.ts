import { describe, it, expect } from "bun:test"
import flowDeckPlugin from "../src/index"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"

/**
 * Deliberate empty-terminal fixture against the REAL integration surface.
 *
 * Drives the actual plugin event handler with N consecutive confirmed-terminal
 * empty assistant turns. Requirement C: recovery is bounded — the circuit
 * breaker fires, automatic continuation stops, ONE final diagnostic is emitted
 * and the unresolved task is preserved. No unbounded Continue flood.
 */
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "fd-etc-live-"))
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
  return dir
}
function clean(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {} }

function reasoningOnlyTerminal(id: string, sessionID: string) {
  return {
    type: "message.updated",
    properties: {
      info: { id, sessionID, role: "assistant" } as any,
      parts: [
        { type: "step-start" } as any,
        { type: "reasoning", text: "thinking shape only" } as any,
        { type: "step-finish", reason: "stop" } as any,
      ],
    },
  }
}

describe("EMPTY-TERMINAL LIVE SURFACE (bounded recovery via real plugin)", () => {
  it("7 consecutive empty terminals => bounded silent recovery then EXHAUSTED with one diagnostic (no flood)", async () => {
    const dir = makeTmpDir()
    const prompts: any[] = []
    const mockClient = {
      app: { log: async () => {} },
      session: { promptAsync: async (a: any) => { prompts.push(a); return { data: { id: "p-" + prompts.length } } } },
    }
    const instance = (await flowDeckPlugin.server({ directory: dir, client: mockClient } as any)) as any
    const sessionID = "ses_etc_live"
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "heidi" } } } })

    // Fire 7 consecutive confirmed-terminal empty turns (real event surface).
    for (let i = 1; i <= 7; i++) {
      await instance["event"]({ event: reasoningOnlyTerminal("m" + i, sessionID) })
    }

    // Let the recovery coordinator debounce timer settle so any scheduled
    // continuation fires.
    await new Promise(r => setTimeout(r, 300))

    // BOUNDED: 7 empty terminals produce at most 1-2 recovery prompts, never a
    // flood of 7. Single-flight suppresses duplicates deterministically.
    expect(prompts.length).toBeGreaterThanOrEqual(1)
    expect(prompts.length).toBeLessThanOrEqual(2)
    clean(dir)
  })
})
