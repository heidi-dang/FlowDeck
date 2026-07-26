#!/usr/bin/env node
// postinstall.mjs — Safe, minimal postinstall for @heidi-dang/flowdeck
//
// Performs ONLY:
// 1. Plugin registration in opencode.json (plugin list), preserving JSONC comments
// 2. Sets default_agent to "heidi" for new installations only
//
// Uses shared config-mutator for all JSONC-safe file operations.
//
// For full installation features, use: npx @heidi-dang/flowdeck install

import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readConfig as readConfigFile, writeConfig } from "./scripts/config-mutator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getOpenCodeConfigDir() {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))
  );
}

function main() {
  const configDir = getOpenCodeConfigDir();
  const configFile = join(configDir, "opencode.json");

  mkdirSync(configDir, { recursive: true });

  let rawContent = "{}";
  let existingData = {};

  if (existsSync(configFile)) {
    const result = readConfigFile(configFile);
    if (!result.ok) {
      console.log(`⚠️  opencode.json is malformed: ${result.error}`);
      console.log("⚠️  Preserving existing configuration without mutation.");
      console.log("   Run 'npx @heidi-dang/flowdeck doctor' for diagnosis.");
      console.log("   Run 'npx @heidi-dang/flowdeck install' to attempt repair.");
      return;
    }
    rawContent = result.rawContent ?? "{}";
    existingData = result.data ?? {};
  }

  const edits = [];
  let changed = false;

  // Plugin registration
  const pluginRef = "@heidi-dang/flowdeck";
  const pluginList = Array.isArray(existingData?.plugin) ? existingData.plugin : [];
  const alreadyRegistered = pluginList.some(
    (p) => p === pluginRef || String(p).startsWith(pluginRef + "@")
  );
  if (!alreadyRegistered) {
    edits.push({ path: ["plugin"], value: [...pluginList, pluginRef] });
    console.log(`✓ Added ${pluginRef} to plugin list`);
    changed = true;
  } else {
    console.log(`✓ Plugin already registered`);
  }

  // Set default_agent to heidi for new installations ONLY
  if (existingData?.default_agent === undefined || existingData?.default_agent === null) {
    edits.push({ path: ["default_agent"], value: "heidi" });
    console.log(`✓ Set default_agent to heidi`);
    changed = true;
  } else {
    console.log(`✓ default_agent already set to "${existingData.default_agent}" — preserved`);
  }

  if (!changed) {
    console.log("\n✓ FlowDeck postinstall complete (no changes needed).");
    return;
  }

  // Use shared writeConfig: validates, backs up, applies JSONC edits, writes atomically
  const result = writeConfig(configFile, rawContent, edits);
  if (result.ok) {
    console.log(`\n✓ FlowDeck ready! A fresh OpenCode session is required to activate.`);
    console.log(`  Config: ${configDir}`);
  } else {
    console.error(`✗ Failed to write configuration: ${result.error}`);
    process.exit(1);
  }
}

main();
