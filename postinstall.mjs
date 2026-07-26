// postinstall.mjs — Safe, minimal postinstall for @heidi-dang/flowdeck
//
// Performs ONLY:
// 1. Plugin registration in opencode.json (plugin list), preserving JSONC comments
// 2. Sets default_agent to "heidi" for new installations only
//
// Does NOT:
// - Clone any Git repository
// - Pull latest branch
// - Install Rust or rustup
// - Compile FDX
// - Change existing default_agent
// - Hide errors behind unconditional exit code zero
// - Require machine-level toolchain installation
//
// For full installation features, use: npx @heidi-dang/flowdeck install

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { modify, applyEdits, parse } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getOpenCodeConfigDir() {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))
  );
}

/**
 * Apply JSONC-preserving edits using jsonc-parser.
 * Preserves comments, formatting, and trailing commas.
 */
function applyJsoncEdits(rawContent, edits) {
  let content = rawContent;
  for (const edit of edits) {
    content = applyEdits(content, modify(content, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  return content;
}

function main() {
  const configDir = getOpenCodeConfigDir();
  const configFile = join(configDir, "opencode.json");

  mkdirSync(configDir, { recursive: true });

  let rawContent = "{}";
  let existingData = {};

  if (existsSync(configFile)) {
    rawContent = readFileSync(configFile, "utf-8");
    const errors = [];
    existingData = parse(rawContent, errors, { allowTrailingComma: true });
    if (errors.length > 0 || existingData === undefined) {
      console.log(`⚠️  opencode.json is malformed (parse error code: ${errors.join(", ") || "unknown"}).`);
      console.log("⚠️  Preserving existing configuration without mutation.");
      console.log("   Run 'npx @heidi-dang/flowdeck doctor' for diagnosis.");
      console.log("   Run 'npx @heidi-dang/flowdeck install' to attempt repair.");
      return;
    }
  }

  // Create backup before any mutation
  try {
    copyFileSync(configFile, configFile + ".pre-install.bak");
  } catch {
    // Failed backup — still proceed for registration
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

  // Apply JSONC-preserving edits and write atomically
  const updatedContent = applyJsoncEdits(rawContent, edits);
  const tmpFile = join(configDir, `.opencode.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmpFile, updatedContent, "utf-8");
    renameSync(tmpFile, configFile);
    console.log(`\n✓ FlowDeck ready! A fresh OpenCode session is required to activate.`);
    console.log(`  Config: ${configDir}`);
  } catch (err) {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    console.error(`✗ Failed to write configuration: ${err.message}`);
    process.exit(1);
  }
}

main();
