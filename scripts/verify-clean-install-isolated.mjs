#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = mkdtempSync(join(tmpdir(), "flowdeck-clean-install-"))
const home = join(root, "home")
const config = join(root, "config")
const cache = join(root, "cache")
const data = join(root, "data")
const npmPrefix = join(root, "npm")

try {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
    OPENCODE_CONFIG_DIR: join(config, "opencode"),
  }
  execFileSync(process.execPath, [resolve("bin/flowdeck.js"), "clean-install", "--verify-only", "--no-verify-runtime"], {
    cwd: resolve("."),
    env,
    stdio: "inherit",
  })
  console.log("Isolated clean-install verification passed; host FlowDeck state was not consulted.")
} finally {
  rmSync(root, { recursive: true, force: true })
}
