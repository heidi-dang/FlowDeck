import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import flowDeckPlugin, {
  cleanupSessionState,
  getSessionMetricsDiagnostics,
} from "../src/index"
import { auditLogPath } from "../src/services/audit-log"

describe("live OpenCode plugin orchestration acceptance", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("covers direct execution, specialist correlation, recovery, verification, and cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowdeck-live-acceptance-"))
    directories.push(directory)
    writeFileSync(join(directory, ".flowdeck.json"), JSON.stringify({
      governance: { mode: "advisory", validator: { mode: "advisory" } },
    }))
    const logs: string[] = []
    const plugin = await flowDeckPlugin.server({
      directory,
      client: { app: { log: async ({ body }: any) => { logs.push(body.message) } } },
    } as never)
    const hooks = plugin as any
    const parent = "acceptance-parent"

    await hooks.event({
      event: { type: "session.created", properties: { info: { id: parent, agent: "heidi" } } },
    })
    const finalMessage = { message: { agent: "heidi", system: "Acceptance system." } }
    await hooks["chat.message"]({ sessionID: parent, agent: "heidi" }, finalMessage)
    expect(finalMessage.message.system).toContain("Runtime agent ID: heidi")

    await hooks["tool.execute.before"](
      { tool: "fdx-read", sessionID: parent, callID: "direct-read" },
      { args: { file: "package.json" } },
    )
    await hooks["tool.execute.after"](
      { tool: "fdx-read", sessionID: parent, callID: "direct-read" },
      { args: { file: "package.json" }, output: "{}" },
    )

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: parent, callID: "specialist-1" },
      { args: { subagent_type: "security-auditor", prompt: "Audit authentication boundaries" } },
    )
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "acceptance-child", parentID: parent, agent: "security-auditor" } },
      },
    })
    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: "acceptance-child", error: { message: "specialist failed" } },
      },
    })

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: parent, callID: "recovery-1" },
      { args: { subagent_type: "debug-specialist", prompt: "Recover the failed audit" } },
    )
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: parent, callID: "recovery-1" },
      { output: "Recovery verified", metadata: {} },
    )

    expect(existsSync(auditLogPath(directory))).toBe(true)
    const events = readFileSync(auditLogPath(directory), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((event) =>
      event.kind === "delegation.failed" &&
      event.details?.targetAgent === "security-auditor"
    )).toBe(true)
    expect(events.some((event) =>
      event.kind === "delegation.completed" &&
      event.details?.targetAgent === "debug-specialist"
    )).toBe(true)
    expect(logs.some((message) => message.includes("tool=fdx-read"))).toBe(true)

    cleanupSessionState(parent)
    expect(getSessionMetricsDiagnostics(parent)).toMatchObject({
      toolCalls: 0,
      retries: 0,
      delegations: 0,
      filesChangedCount: 0,
    })
  })
})
