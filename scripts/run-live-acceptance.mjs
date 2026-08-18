#!/usr/bin/env node

/**
 * Cross-platform runner for the real FlowDeck live acceptance suite.
 * Requires genuine live OpenCode and FlowDeck WebUI servers running.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const OPENCODE_URL = process.env.FLOWDECK_LIVE_OPENCODE_URL || "http://127.0.0.1:4096"
const FLOWDECK_WEBUI_URL = process.env.FLOWDECK_LIVE_WEBUI_URL || "http://127.0.0.1:44565"

function getBunExecutable() {
  if (process.platform !== "win32") return "bun"
  const appData = process.env.APPDATA
  if (appData) {
    const npmBunExe = join(appData, "npm", "node_modules", "bun", "bin", "bun.exe")
    if (existsSync(npmBunExe)) return npmBunExe
  }
  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    const userBunExe = join(userProfile, ".bun", "bin", "bun.exe")
    if (existsSync(userBunExe)) return userBunExe
  }
  return "bun.exe"
}

console.log("=== Running FlowDeck Live Acceptance Suite ===")
console.log("OpenCode Target URL:", OPENCODE_URL)
console.log("FlowDeck WebUI URL :", FLOWDECK_WEBUI_URL)

const env = {
  ...process.env,
  FLOWDECK_LIVE_ACCEPTANCE: "1",
  FLOWDECK_LIVE_OPENCODE_URL: OPENCODE_URL,
  FLOWDECK_LIVE_WEBUI_URL: FLOWDECK_WEBUI_URL,
}

const bunBin = getBunExecutable()
const proc = spawnSync(bunBin, ["test", "tests/live/live-acceptance-vertical-proof.test.ts"], {
  stdio: "inherit",
  env,
  shell: false,
})

if (proc.error) {
  console.error("Failed to execute bun:", proc.error.message)
  process.exit(1)
}

process.exit(proc.status ?? 1)
