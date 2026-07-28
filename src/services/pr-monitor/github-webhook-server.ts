/**
 * GitHub App webhook server for PR Monitor.
 * Listens for workflow_job:completed events and triggers the repair pipeline.
 *
 * Requires GITHUB_WEBHOOK_SECRET env var for HMAC-SHA256 verification.
 */

import { createHmac, timingSafeEqual } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import { createServer } from "http"
import type { GitHubWebhookPayload } from "./types"
import { buildDedupKey } from "./types"

const WEBHOOK_SECRET_ENV = "GITHUB_WEBHOOK_SECRET"

export type WebhookHandler = (payload: GitHubWebhookPayload) => Promise<void>

export class GitHubWebhookServer {
  private server: ReturnType<typeof createServer> | null = null
  private seenDeliveries = new Set<string>()
  private handler: WebhookHandler | null = null

  constructor(private port = 0) {}

  onEvent(handler: WebhookHandler): void {
    this.handler = handler
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.port, () => {
        const addr = this.server?.address()
        const port = typeof addr === "object" && addr ? addr.port : 0
        resolve(port)
      })
      this.server.on("error", reject)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed")
      return
    }

    const deliveryId = req.headers["x-github-delivery"] as string
    const event = req.headers["x-github-event"] as string
    const signature = req.headers["x-hub-signature-256"] as string

    if (!deliveryId || !event || !signature) {
      res.writeHead(400).end("Missing headers")
      return
    }

    const body = await this.readBody(req)

    // Verify signature
    if (!this.verifySignature(body, signature)) {
      res.writeHead(401).end("Invalid signature")
      return
    }

    // Deduplicate
    const dedupKey = `${deliveryId}:${event}`
    if (this.seenDeliveries.has(dedupKey)) {
      res.writeHead(200).end("Duplicate")
      return
    }
    this.seenDeliveries.add(dedupKey)
    // Prune old entries
    if (this.seenDeliveries.size > 1000) {
      const arr = [...this.seenDeliveries]
      this.seenDeliveries = new Set(arr.slice(arr.length - 500))
    }

    // Parse body
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body.toString("utf-8"))
    } catch {
      res.writeHead(400).end("Invalid JSON")
      return
    }

    res.writeHead(200).end("OK")

    // Fire handler asynchronously
    if (this.handler) {
      const payload: GitHubWebhookPayload = {
        delivery_id: deliveryId,
        event,
        signature_256: signature,
        body: parsedBody,
      }
      this.handler(payload).catch(err => {
        console.error("[pr-monitor] webhook handler error:", err)
      })
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => resolve(Buffer.concat(chunks)))
    })
  }

  private verifySignature(body: Buffer, signature: string): boolean {
    const secret = process.env[WEBHOOK_SECRET_ENV]
    if (!secret) return false
    const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature
    const expected = createHmac("sha256", secret).update(body).digest("hex")
    if (sig.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  }
}
