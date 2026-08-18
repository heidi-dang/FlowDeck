import { describe, it, expect } from "bun:test"
import flowDeckPlugin from "../src/index"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { HeidiActiveCoordinator, registerParallelCoordinator, getParallelCoordinator, clearParallelCoordinator } from "../src/services/heidi-active-coordinator"
import { renderParallelPacket } from "../src/services/heidi-parallel-context"

function clean(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {} }

describe("ACTIVE PARALLEL — OpenCode contract surface (no real provider)", () => {
  it("a coordinator-driven task feeds READY + a compact packet on the real plugin surface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-par-contract-"))
    writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
    const wakePrompts: string[] = []
    const instance = (await flowDeckPlugin.server({ directory: dir, client: { app: { log: async () => {} }, session: { promptAsync: async (a: any) => { wakePrompts.push(String(a?.body?.text ?? "")); return { data: { id: "wake-1" } } } } } } as any)) as any
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: "s-par", agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: "s-par", agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })

    // Register the active coordinator exactly as index.ts does for PARALLEL_SPECIALISTS.
    const coord = new HeidiActiveCoordinator({
      parentSessionId: "s-par",
      runId: "par_audit",
      goal: "frontend + backend",
      coordinatorOwnership: { integrationScopes: ["src/index.ts", "tests/"], readScopes: ["src/"] },
      children: [
        { workstreamId: "par_0_frontend-coder", specialist: "frontend-coder", goal: "ui", access: "write" },
        { workstreamId: "par_1_backend-coder", specialist: "backend-coder", goal: "api", access: "write" },
      ],
    })
    registerParallelCoordinator("s-par", coord)

    // One specialist completes via the task tool -> child.completed feeds the coordinator.
    await instance["tool.execute.before"]({ tool: "task", sessionID: "s-par", callID: "t1", args: {} }, { args: { subagent_type: "backend-coder", prompt: "api" } } as any)
    await instance["tool.execute.after"]({ tool: "task", sessionID: "s-par", callID: "t1", args: { subagent_type: "backend-coder" } }, { output: "done", metadata: {} } as any)

    const ready = getParallelCoordinator("s-par")!.getReadyResults()
    expect(ready).toContain("par_1_backend-coder")

    const packet = renderParallelPacket("s-par")
    expect(packet.length).toBeGreaterThan(0)
    expect(packet).toMatch(/Ready: [1-9]/)
    expect(packet.length / 4).toBeLessThan(200)
    expect(packet).not.toContain("Continue")
    expect(packet).not.toContain("Check your subagents")

    // Packet reflects the ready workstream explicitly.
    expect(packet).toContain("backend-coder")

    if (instance?.dispose) { try { await instance.dispose() } catch {} }
    clearParallelCoordinator("s-par")
    clean(dir)
  }, 20000)
})
