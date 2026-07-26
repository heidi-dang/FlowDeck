// postinstall.mjs — Safe, minimal postinstall for @heidi-dang/flowdeck
//
// Performs ONLY:
// 1. Plugin registration in opencode.json (plugin list)
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
 * Strip single-line and multi-line comments from JSONC text safely,
 * preserving strings that contain comment delimiters.
 */
function stripJsonComments(jsoncText) {
  let insideString = false;
  let insideComment = false; // false | "single" | "multi"
  let result = "";
  for (let i = 0; i < jsoncText.length; i++) {
    const char = jsoncText[i];
    const nextChar = jsoncText[i + 1];
    if (insideComment === "single") {
      if (char === "\n" || char === "\r") {
        insideComment = false;
        result += char;
      }
      continue;
    }
    if (insideComment === "multi") {
      if (char === "*" && nextChar === "/") {
        insideComment = false;
        i++;
      }
      continue;
    }
    if (insideString) {
      result += char;
      if (char === "\\" && i + 1 < jsoncText.length) {
        result += jsoncText[++i];
      } else if (char === insideString) {
        insideString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      insideString = char;
      result += char;
      continue;
    }
    if (char === "/" && nextChar === "/") {
      insideComment = "single";
      i++;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      insideComment = "multi";
      i++;
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Safe parse with exact error location.
 */
function safeParse(content) {
  try {
    const stripped = stripJsonComments(content);
    return { ok: true, data: JSON.parse(stripped), rawContent: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, rawContent: content };
  }
}

function main() {
  const configDir = getOpenCodeConfigDir();
  const configFile = join(configDir, "opencode.json");

  mkdirSync(configDir, { recursive: true });

  let rawContent = "{}";
  let existingData = {};

  if (existsSync(configFile)) {
    rawContent = readFileSync(configFile, "utf-8");
    const parsed = safeParse(rawContent);
    if (!parsed.ok) {
      // Malformed config — do NOT modify. Preserve byte-for-byte.
      console.log(`⚠️  opencode.json is malformed: ${parsed.error}`);
      console.log("⚠️  Preserving existing configuration without mutation.");
      console.log("   Run 'npx @heidi-dang/flowdeck doctor' for diagnosis.");
      return;
    }
    existingData = parsed.data || {};
  }

  // Create backup before any mutation
  const isJsonc = rawContent.trim().includes("//") || rawContent.trim().includes("/*");
  // We always back up the raw content (JSONC preserves comments in backup)
  const backupPath = configFile + ".pre-install.bak";
  try {
    copyFileSync(configFile, backupPath);
  } catch {
    // Failed backup — still proceed for registration
  }

  const updated = JSON.parse(JSON.stringify(existingData));
  let changed = false;

  // Plugin registration
  if (!Array.isArray(updated.plugin)) updated.plugin = [];
  const pluginRef = "@heidi-dang/flowdeck";
  const alreadyRegistered = updated.plugin.some(
    (p) => p === pluginRef || String(p).startsWith(pluginRef + "@")
  );
  if (!alreadyRegistered) {
    updated.plugin.push(pluginRef);
    console.log(`✓ Added ${pluginRef} to plugin list`);
    changed = true;
  } else {
    console.log(`✓ Plugin already registered`);
  }

  // Set default_agent to heidi for new installations ONLY
  // Preserve existing explicit settings
  if (updated.default_agent === undefined || updated.default_agent === null) {
    updated.default_agent = "heidi";
    console.log(`✓ Set default_agent to heidi`);
    changed = true;
  } else {
    console.log(`✓ default_agent already set to "${updated.default_agent}" — preserved`);
  }

  if (!changed) {
    console.log("\n✓ FlowDeck postinstall complete (no changes needed).");
    return;
  }

  // Atomic write: temp file + rename
  const tmpFile = join(configDir, `.opencode.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2) + "\n", "utf-8");
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
