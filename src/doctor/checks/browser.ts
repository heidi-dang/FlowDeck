import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { CheckResult } from "../types"

export async function runBrowserChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // 1. Check agent-browser module availability
  const agentBrowserModule = join(directory, "src", "browser", "adapter.ts")
  const hasAgentBrowser = existsSync(agentBrowserModule)

  // 2. Check Chrome / Chromium executable
  let chromeFound = false
  let chromePath = "none"

  const chromeCandidates = [
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[]

  for (const cand of chromeCandidates) {
    if (existsSync(cand)) {
      chromeFound = true
      chromePath = cand
      break
    }
  }

  if (!chromeFound) {
    // Try which / npx chrome
    try {
      const out = execFileSync(process.platform === "win32" ? "where" : "which", ["google-chrome"], { encoding: "utf-8", timeout: 2000 })
      if (out.trim()) {
        chromeFound = true
        chromePath = out.trim().split("\n")[0]
      }
    } catch {
      // ignore
    }
  }

  if (chromeFound) {
    checks.push({
      id: "browser.chrome",
      title: "Chrome / Chromium Browser",
      category: "browser",
      severity: "info",
      status: "pass",
      detected: `Browser executable found at ${chromePath}`,
      expected: "Chrome/Chromium available",
      recommendation: "Browser debugging ready",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  } else {
    checks.push({
      id: "browser.chrome",
      title: "Chrome / Chromium Browser",
      category: "browser",
      severity: "medium",
      status: "warning",
      detected: "No local Chrome / Chromium binary found",
      expected: "Chrome or Chromium browser installed",
      recommendation: "Install Chrome/Chromium or set CHROME_BIN environment variable",
      autoFixAvailable: false,
      affectsRuntime: true,
      repairability: "manual",
    })
  }

  if (hasAgentBrowser) {
    checks.push({
      id: "browser.agent_browser",
      title: "Heidi Browser Adapter",
      category: "browser",
      severity: "info",
      status: "pass",
      detected: "Heidi agent-browser module ready",
      expected: "Agent-browser module available",
      recommendation: "Autonomous browser debugging ready",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  }

  return checks
}
