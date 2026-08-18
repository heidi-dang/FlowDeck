import { describe, it, expect } from "bun:test"

const OPENCODE_URL = process.env.FLOWDECK_LIVE_OPENCODE_URL || "http://127.0.0.1:4096"
const FLOWDECK_WEBUI_URL = process.env.FLOWDECK_LIVE_WEBUI_URL || "http://127.0.0.1:44565"

describe("Real OpenCode + WebUI Live Acceptance Suite", () => {
  it("verifies live OpenCode server is running and responding with version 1.18.18", async () => {
    const res = await fetch(OPENCODE_URL + "/")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("<title>OpenCode</title>")
  })

  it("verifies live FlowDeck WebUI dashboard is streaming scores and session health", async () => {
    const healthRes = await fetch(
      FLOWDECK_WEBUI_URL + "/api/v1/servers/default/projects/flowdeck-antigravity/better-harness/session-health"
    )
    expect(healthRes.status).toBe(200)
    const health = (await healthRes.json()) as any
    expect(health.currentHealth).toBeGreaterThan(0)
    expect(health.sessionIntegrity).toBeGreaterThan(0)

    const uiRes = await fetch(
      FLOWDECK_WEBUI_URL + "/api/v1/servers/default/projects/flowdeck-antigravity/better-harness/ui/runtime-scores"
    )
    expect(uiRes.status).toBe(200)
    const ui = (await uiRes.json()) as any
    expect(ui.html).toContain("FlowDeck Runtime Integrity")
    expect(ui.html).toContain("Current Health")
    expect(ui.html).toContain("Session Integrity")
  })
})
