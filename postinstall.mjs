#!/usr/bin/env node
// postinstall.mjs — Safe, minimal postinstall for @heidi-dang/flowdeck
//
// This script is intentionally side-effect-free. npm postinstall hooks
// run in uncontrolled environments and must NOT mutate user configuration
// files. The explicit install command handles all setup.
//
// Usage:
//   npx @heidi-dang/flowdeck install   ← complete setup
//   npx @heidi-dang/flowdeck doctor    ← diagnose installation

function main() {
  console.log("\n✓ FlowDeck installed.");
  console.log("  Run 'npx @heidi-dang/flowdeck install' to complete setup.");
}

main();
