#!/usr/bin/env node
// bin/better-harness.js — FlowDeck Better Harness standalone CLI
//
// Explicit entry point for the Better Harness development/QA runtime.
// The production FlowDeck plugin never activates the harness runtime; this
// command is the only supported way to run it.
//
// Usage:
//   flowdeck-better-harness --project <path> [--state-dir <dir>] [--port <port>] [--host <host>]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadStandalone() {
  // Prefer the built dist output; fall back to the TypeScript source.
  try {
    return await import(join(__dirname, "..", "dist", "better-harness", "standalone.js"));
  } catch {
    return await import(join(__dirname, "..", "src", "better-harness", "standalone.ts"));
  }
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  // Delegate help to the standalone module's parser.
  const mod = await loadStandalone();
  mod.printHelp?.();
  process.exit(0);
}

const mod = await loadStandalone();
const opts = mod.parseArgs?.(args) ?? { project: args[0] ?? "" };

mod.startStandaloneServer(opts)
  .then((handle) => {
    console.log(`[flowdeck-better-harness] Running standalone (project=${handle.projectDir})`);
    console.log(`[flowdeck-better-harness] State dir: ${handle.stateDir}`);
    console.log(`[flowdeck-better-harness] HTTP base URL: ${handle.baseUrl}`);
    console.log(`[flowdeck-better-harness] Press Ctrl+C to stop.`);

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[flowdeck-better-harness] Shutting down...`);
      handle.shutdown().then(() => {
        console.log(`[flowdeck-better-harness] Stopped.`);
        process.exit(0);
      }).catch((err) => {
        console.error(`[flowdeck-better-harness] Shutdown error: ${err.message}`);
        process.exit(1);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error(`[flowdeck-better-harness] Failed to start: ${err.message}`);
    process.exit(1);
  });