import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { GitHubWebhookServer } from "../src/services/pr-monitor/github-webhook-server"
import { createHmac } from "crypto"

describe("GitHubWebhookServer Unit Tests", () => {
  let server: GitHubWebhookServer
  let port: number
  const secret = "test-webhook-secret"

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret
    server = new GitHubWebhookServer(0)
    port = await server.start()
  })

  afterEach(() => {
    server.stop()
    delete process.env.GITHUB_WEBHOOK_SECRET
  })

  function signPayload(body: string): string {
    const hmac = createHmac("sha256", secret).update(body).digest("hex")
    return `sha256=${hmac}`
  }

  it("rejects non-POST requests with 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, { method: "GET" })
    expect(res.status).toBe(405)
  })

  it("rejects missing headers with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("Missing headers")
  })

  it("rejects invalid signature with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "x-github-delivery": "del-1",
        "x-github-event": "workflow_job",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("accepts valid signed request and triggers handler", async () => {
    let capturedPayload: any = null
    server.onEvent(async (payload) => {
      capturedPayload = payload
    })

    const body = JSON.stringify({ action: "completed", workflow_job: { id: 123 } })
    const sig = signPayload(body)

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "x-github-delivery": "del-valid-1",
        "x-github-event": "workflow_job",
        "x-hub-signature-256": sig,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("OK")

    // Give handler a tick to complete
    await new Promise((r) => setTimeout(r, 10))
    expect(capturedPayload).not.toBeNull()
    expect(capturedPayload.delivery_id).toBe("del-valid-1")
    expect(capturedPayload.event).toBe("workflow_job")
    expect(capturedPayload.body.action).toBe("completed")
  })

  it("handles duplicate delivery id gracefully", async () => {
    const body = JSON.stringify({ action: "completed" })
    const sig = signPayload(body)

    const sendReq = () =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "x-github-delivery": "del-dup-1",
          "x-github-event": "workflow_job",
          "x-hub-signature-256": sig,
        },
        body,
      })

    const res1 = await sendReq()
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe("OK")

    const res2 = await sendReq()
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe("Duplicate")
  })

  it("rejects malformed JSON payload with 400", async () => {
    const body = "{ invalid json content"
    const sig = signPayload(body)

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "x-github-delivery": "del-bad-json",
        "x-github-event": "workflow_job",
        "x-hub-signature-256": sig,
      },
      body,
    })

    expect(res.status).toBe(400)
    expect(await res.text()).toBe("Invalid JSON")
  })
})
