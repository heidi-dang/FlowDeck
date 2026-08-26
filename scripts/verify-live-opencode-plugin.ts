#!/usr/bin/env bun
/**
 * Explicit native qualification for the installed FlowDeck OpenCode plugin.
 *
 * Required environment:
 *   OPENCODE_BIN=/absolute/path/to/opencode-v1.18.19
 *
 * This command intentionally fails when the supported runtime is unavailable;
 * it never skips or substitutes mocks. It uses server readiness and message
 * events rather than sleeps or retries.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenCodeMessageId } from "../src/runtime/opencode-identifier";

const opencodeBin = process.env.OPENCODE_BIN;
if (!opencodeBin) throw new Error("OPENCODE_BIN is required for native FlowDeck qualification");

const projectDirectory = process.cwd();
const home = mkdtempSync(join(tmpdir(), "flowdeck-live-opencode-home-"));
const port = Number(process.env.FLOWDECK_LIVE_OPENCODE_PORT ?? 4197);
const baseUrl = `http://127.0.0.1:${port}`;
const environment = { ...process.env, HOME: home };

function waitForListening(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    if (!stdout || typeof stdout === "number") return reject(new Error("OpenCode server did not provide stdout"));
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    const consume = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.includes("opencode server listening")) return resolve();
      }
      reject(new Error(`OpenCode exited before becoming ready: ${output}`));
    };
    void consume();
  });
}

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* non-JSON 204 responses are valid */ }
  return { status: response.status, body };
}

async function waitForMessageEvent(sessionId: string, messageId: string): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/event`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`OpenCode event subscription failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("OpenCode event stream closed before message persistence");
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        const properties = event.properties as any;
        const eventSessionId = properties?.sessionID ?? properties?.info?.sessionID ?? properties?.part?.sessionID;
        const eventMessageId = properties?.messageID ?? properties?.info?.id ?? properties?.part?.messageID;
        if (eventSessionId === sessionId && eventMessageId === messageId && event.type === "message.updated") return;
      }
    }
  } finally {
    controller.abort();
  }
}

try {
  const installer = Bun.spawn(["node", "bin/flowdeck.js", "install", "--local-repo"], {
    cwd: projectDirectory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const installerExit = await installer.exited;
  if (installerExit !== 0) {
    throw new Error(`FlowDeck local-plugin installation failed: ${await new Response(installer.stderr).text()}`);
  }

  const server = Bun.spawn([opencodeBin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectDirectory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForListening(server);
    const agents = await request("/agent");
    const agentRows = Array.isArray(agents.body) ? agents.body : [];
    if (agents.status !== 200 || !agentRows.some((agent: any) => agent?.name === "heidi")) {
      throw new Error(`Installed FlowDeck plugin did not register Heidi: ${JSON.stringify(agents)}`);
    }

    const session = await request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const sessionId = (session.body as { id?: string } | null)?.id;
    if (session.status !== 200 || !sessionId) throw new Error(`Session creation failed: ${JSON.stringify(session)}`);

    const messageId = createOpenCodeMessageId("descending");
    const messagePersisted = waitForMessageEvent(sessionId, messageId);
    const prompt = await request(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageID: messageId,
        agent: "heidi",
        noReply: true,
        parts: [{ type: "text", text: "FlowDeck installed-plugin native message identity qualification." }],
      }),
    });
    if (prompt.status !== 204) throw new Error(`Native Heidi prompt was rejected: ${JSON.stringify(prompt)}`);
    await messagePersisted;

    const events = await request(`/session/${sessionId}/message`);
    const messages = Array.isArray(events.body) ? events.body : [];
    const echoed = messages.find((entry: any) => entry?.info?.id === messageId);
    if (echoed?.info?.role !== "user") {
      throw new Error(`Native message identity was not preserved as role=user: ${JSON.stringify(events)}`);
    }

    console.log(JSON.stringify({
      qualified: true,
      runtime: "opencode",
      sessionId,
      messageId,
      persistedRole: echoed.info.role,
    }, null, 2));
  } finally {
    server.kill();
    await server.exited;
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
