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
  // The compiled standalone module is the ONLY supported runtime source.
  // TypeScript source under src/ is intentionally NOT a fallback: it is not
  // shipped in the npm package and is not an acceptable installed runtime
  // dependency. If the compiled module is absent the package has not been
  // built (or the install is corrupt) — fail with a clear diagnostic.
  const standalonePath = join(__dirname, "..", "dist", "better-harness", "standalone.js");
  try {
    return await import(standalonePath);
  } catch (err) {
    console.error(
      `[flowdeck-better-harness] Compiled standalone module not found: ${standalonePath}`,
    );
    console.error(
      "[flowdeck-better-harness] Run `npm run build` in the package checkout, or reinstall",
    );
    console.error(
      "[flowdeck-better-harness] the package from a release tarball, then retry this command.",
    );
    console.error(
      `[flowdeck-better-harness] Load error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
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