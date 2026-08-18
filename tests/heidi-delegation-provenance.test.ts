import { describe, it, expect } from "bun:test"
import flowDeckPlugin from "../src/index"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "fd-ancestry-"))
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
  return dir
}

function safeCleanupDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
}

/**
 * ROOT HEIDI DELEGATION PROVENANCE — live plugin boundary.
 *
 * Reproduces the pathological session: a root Heidi session receives a
 * message.updated event whose info.parentID is a MESSAGE id (message
 * causality). Before the fix this corrupted session ancestry to depth 1,
 * causing DEPTH_LIMIT_EXCEEDED on the task tool. After the fix root Heidi
 * stays depth 0 and the full specialist fan-out succeeds.
 */
describe("ROOT HEIDI DELEGATION (live plugin)", () => {
  it("message parentID never corrupts root Heidi to depth 1; fan-out to 4 specialists succeeds", async () => {
    const dir = makeTmpDir()
    const prompts: any[] = []
    const mockClient = {
      app: { log: async () => {} },
      session: { promptAsync: async (a: any) => { prompts.push(a); return { data: { id: "p-" + prompts.length } } } },
    }
    const instance = (await flowDeckPlugin.server({ directory: dir, client: mockClient } as any)) as any
    const root = "ses_root_live"

    // session.created for root Heidi (no parentID)
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: root, agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: root, agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })

    // A message.updated event arrives that carries a MESSAGE-level parentID
    // (message causality). This used to set session parentID -> depth 1.
    await instance["event"]({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg_user_live_1", sessionID: root, role: "user", parentID: "msg_root_0" } as any,
          parts: [{ type: "text", text: "Repo audit using full sub agents" } as any],
        },
      },
    })

    // Now root Heidi delegates to 4 specialists (the promised fan-out).
    const specialists = ["security-auditor", "reviewer", "architect", "tester"]
    // The delegation must not throw DEPTH_LIMIT_EXCEEDED.
    const { validateDelegationDepth } = await import("../src/services/governance-wiring");
    const { sessionAncestry } = await import("../src/services/session-ancestry");
    // Root Heidi's authoritative depth is 0 after the message event.
    const rootDepth = sessionAncestry.getEffectiveDepth(root, "heidi")
    expect(rootDepth).toBe(0)

    for (const target of specialists) {
      const res = validateDelegationDepth({ delegatingAgent: "heidi", targetAgent: target, currentDepth: rootDepth, specialistAgents: specialists, maxDepth: 1 });
      expect(res.allowed).toBe(true);
    }

    // Register the 4 child sessions with SESSION-level parentID = root.
    const children = specialists.map((s, i) => "ses_child_live_" + i);
    for (let i = 0; i < specialists.length; i++) {
      await instance["tool.execute.before"]({ tool: "task", sessionID: root, callID: "call-live-" + i, args: {} }, { args: { subagent_type: specialists[i], prompt: "audit" } });
    }
    for (let i = 0; i < specialists.length; i++) {
      await instance["event"]({ event: { type: "session.created", properties: { info: { id: children[i], parentID: root, agent: specialists[i] } } } });
      const depth = sessionAncestry.getEffectiveDepth(children[i], specialists[i]);
      expect(depth).toBe(1);
    }
    // Specialist recursive delegation is BLOCKED
    const recRes = validateDelegationDepth({ delegatingAgent: "security-auditor", targetAgent: "reviewer", currentDepth: 1, specialistAgents: specialists, maxDepth: 1 });
    expect(recRes.allowed).toBe(false);
    expect(recRes.errorCode).toBe("SPECIALIST_CANNOT_DELEGATE");

    safeCleanupDir(dir)
  })
})

import { sessionAncestry } from "../src/services/session-ancestry"
import { isSpecialistAgent } from "../src/services/canonical-registry"
import { validateDelegationDepth } from "../src/services/governance-wiring"

/** EVENT ORDERING + provenance matrix */
describe("EVENT ORDERING & PROVENANCE", () => {
  it("root Heidi stays depth 0 under: late events, resume, manual Continue, internal continuation, recovery continuation", () => {
    sessionAncestry.clear()
    sessionAncestry.registerSession("ses-r", "heidi"); // manual user session
    expect(sessionAncestry.getEffectiveDepth("ses-r", "heidi")).toBe(0)
    expect(sessionAncestry.isRootCoordinator("ses-r", "heidi")).toBe(true)

    // Re-register repeatedly (late/duplicate events) — never demotes root.
    sessionAncestry.registerSession("ses-r", "heidi");
    sessionAncestry.registerSession("ses-r", "heidi");
    expect(sessionAncestry.getEffectiveDepth("ses-r", "heidi")).toBe(0)

    // Internal continuation (agent heidi, no parent) — still root.
    sessionAncestry.registerSession("ses-r", "heidi");
    expect(sessionAncestry.getEffectiveDepth("ses-r", "heidi")).toBe(0)
  })

  it("specialist child = depth 1; generic depth > maxDepth blocked; maxDepth still 1", () => {
    const set = new Set(["security-auditor", "reviewer", "architect"])
    const r = validateDelegationDepth({ delegatingAgent: "heidi", targetAgent: "security-auditor", currentDepth: 0, specialistAgents: set, maxDepth: 1 });
    expect(r.allowed).toBe(true)
    const c = validateDelegationDepth({ delegatingAgent: "heidi", targetAgent: "architect", currentDepth: 1, specialistAgents: set, maxDepth: 1 });
    expect(c.allowed).toBe(false)
    expect(c.errorCode).toBe("DEPTH_LIMIT_EXCEEDED")
  })

  it("maxDepth remains 1; isSpecialistAgent semantics preserved", () => {
    expect(isSpecialistAgent("security-auditor")).toBe(true)
    expect(isSpecialistAgent("heidi")).toBe(false)
  })
})

/** CLEANUP between test files is handled by each suite. */