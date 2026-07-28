#!/usr/bin/env node
// bin/flowdeck.js — Thin launcher for the canonical CLI implementation
// All command logic lives in src/cli/flowdeck.mjs.

import { main } from "../src/cli/flowdeck.mjs";

const argv = process.argv.slice(2);

main(argv).then(({ exitCode }) => {
  process.exit(exitCode);
}).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
