#!/usr/bin/env bun
/**
 * CLI entry point for the standalone FlowDeck Better Harness server.
 *
 * Prints connection metadata as the first JSON line to stdout, then
 * keeps the server running. The parent process can parse the first
 * line to obtain baseUrl, serverKey, and projectKey.
 *
 * Usage:
 *   bun run src/better-harness/testing/standalone-server-cli.ts
 *
 * Output (single JSON line):
 *   {"baseUrl":"http://127.0.0.1:54321","serverKey":"test-server-...","projectKey":"test-project-...","projectId":"test-project"}
 */
import { launchStandaloneServer } from "./standalone-launcher";

async function main() {
  const meta = await launchStandaloneServer();
  const output = {
    baseUrl: meta.baseUrl,
    serverKey: meta.serverKey,
    projectKey: meta.projectKey,
    projectId: meta.projectId,
  };
  // Print metadata as the first line so the parent can parse it
  process.stdout.write(JSON.stringify(output) + "\n");

  // Trap termination signals to clean up temp dirs
  const shutdown = () => {
    meta.shutdown().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);

  // Keep the process alive — the HTTP server runs in the foreground
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Failed to start standalone server:", err);
  process.exit(1);
});
