/**
 * Runtime environment checks.
 */

import { execFile } from "child_process"
import { promisify } from "util"
import type { CheckResult } from "../types"

const execFileAsync = promisify(execFile)

async function tryExec(cmd: string, args: string[] = []): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf-8",
      timeout: 1500,
      shell: process.platform === "win32",
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function tryVersion(cmd: string): Promise<string | null> {
  const out = await tryExec(cmd, ["--version"])
  return out?.split("\n")[0]?.trim() ?? null
}

export function parseOpenCodeVersion(version: string | null): { major: number; minor: number; patch: number } | null {
  if (!version) return null
  const match = version.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function supportsBackgroundSubagents(version: string | null): boolean {
  const parsed = parseOpenCodeVersion(version)
  if (!parsed) return false
  return parsed.major > 1 || (parsed.major === 1 && parsed.minor >= 18)
}

export function backgroundSubagentCapabilityCheck(opencodeVersion: string | null): CheckResult {
  const narrowFlag = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
  const broadFlag = process.env.OPENCODE_EXPERIMENTAL
  const nativeSupport = supportsBackgroundSubagents(opencodeVersion)
  const narrowEnabled = narrowFlag === "true"
  const broadEnabled = narrowFlag === undefined && broadFlag === "true"
  // Match OpenCode's enabledByExperimental contract: an explicit narrow value
  // takes precedence over the broad fallback, including an explicit false.
  const enabled = narrowFlag === undefined ? broadEnabled : narrowEnabled

  let status: "pass" | "warning" | "error" | "info" = "info"
  let severity: "critical" | "high" | "medium" | "low" | "info" = "info"
  let recommendation = "Install OpenCode >= 1.18.0: https://opencode.ai"
  let autoFixAvailable = false
  let repairability: "automatic" | "requires-auth" | "requires-privilege" | "manual" | "not-applicable" = "not-applicable"

  let detected = "OpenCode runtime not found (optional in CLI/standalone mode)"
  if (opencodeVersion) {
    detected = `${opencodeVersion}; native Task background parameter ${nativeSupport ? "supported" : "not supported"}`
    if (narrowEnabled) detected += "; OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"
    else if (broadEnabled) detected += "; enabled through broad OPENCODE_EXPERIMENTAL fallback"
    else detected += "; OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is not enabled"

    if (!nativeSupport) {
      status = "warning"
      severity = "medium"
      recommendation = "Upgrade OpenCode to >= 1.18.0 for native background subagent support"
      repairability = "manual"
    } else if (enabled) {
      status = "pass"
      severity = "info"
      recommendation = broadEnabled && !narrowEnabled
        ? "Prefer OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true instead of the broad OPENCODE_EXPERIMENTAL flag"
        : "Native background Task mode available to Heidi"
      repairability = "not-applicable"
    } else {
      status = "warning"
      severity = "medium"
      recommendation = "Set OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true in the environment that launches OpenCode, then restart OpenCode"
      autoFixAvailable = true
      repairability = "manual"
    }
  }

  return {
    id: "runtime.opencode_background_subagents",
    title: "OpenCode Background Subagents",
    category: "runtime",
    severity,
    status,
    detected,
    evidence: {
      runtimeVersion: opencodeVersion,
      nativeSupport,
      featureEnabled: enabled,
      taskSchemaBackground: nativeSupport && enabled,
      narrowFlag: narrowFlag ?? null,
      broadFlag: broadFlag ?? null,
    },
    expected: "OpenCode >= 1.18.0 with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true",
    recommendation,
    autoFixAvailable,
    affectsRuntime: true,
    repairability,
  }
}

export async function runRuntimeChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  const [
    nodeVer,
    npmVer,
    bunVer,
    gitVer,
    rustcVer,
    _cargoVer,
    pyVer,
    dockerVer,
    opencodeVer,
  ] = await Promise.all([
    tryVersion("node"),
    tryVersion("npm"),
    tryVersion("bun"),
    tryVersion("git"),
    tryVersion("rustc"),
    tryVersion("cargo"),
    tryVersion("python3"),
    tryVersion("docker"),
    tryVersion("opencode"),
  ])

  checks.push(backgroundSubagentCapabilityCheck(opencodeVer))

  // OS
  checks.push({
    id: "runtime.os",
    title: "Operating System",
    category: "runtime",
    severity: "info",
    status: "pass",
    detected: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
    expected: "Linux, macOS, or Windows (WSL2 recommended)",
    recommendation: "WSL2 on Windows provides the best development experience",
    autoFixAvailable: false,
  })

  // Node.js
  if (nodeVer) {
    const major = parseInt(nodeVer.replace("v", "").split(".")[0]) || 0
    checks.push({
      id: "runtime.node",
      title: "Node.js",
      category: "runtime",
      severity: "high",
      status: major >= 18 ? "pass" : "error",
      detected: nodeVer,
      expected: ">= 18.0.0",
      recommendation: major >= 18 ? "OK" : "Install Node.js >= 18 via nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 24",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.node",
      title: "Node.js",
      category: "runtime",
      severity: "high",
      status: "error",
      detected: "not found",
      expected: ">= 18.0.0",
      recommendation: "Install Node.js >= 18: https://nodejs.org",
      autoFixAvailable: false,
    })
  }

  // npm
  if (npmVer) {
    checks.push({
      id: "runtime.npm",
      title: "npm",
      category: "runtime",
      severity: "info",
      status: "pass",
      detected: npmVer,
      expected: "bundled with Node",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.npm",
      title: "npm",
      category: "runtime",
      severity: "low",
      status: "warning",
      detected: "not found",
      expected: "bundled with Node",
      recommendation: "Install npm alongside Node.js",
      autoFixAvailable: false,
    })
  }

  // Bun
  if (bunVer) {
    checks.push({
      id: "runtime.bun",
      title: "Bun",
      category: "runtime",
      severity: "medium",
      status: "pass",
      detected: bunVer,
      expected: "latest",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.bun",
      title: "Bun",
      category: "runtime",
      severity: "medium",
      status: "warning",
      detected: "not found",
      expected: ">= 1.0.0",
      recommendation: "Install Bun: curl -fsSL https://bun.sh/install | bash",
      autoFixAvailable: false,
    })
  }

  // Git
  if (gitVer) {
    checks.push({
      id: "runtime.git",
      title: "Git",
      category: "runtime",
      severity: "high",
      status: "pass",
      detected: gitVer,
      expected: ">= 2.0.0",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.git",
      title: "Git",
      category: "runtime",
      severity: "high",
      status: "error",
      detected: "not found",
      expected: ">= 2.0.0",
      recommendation: "Install Git: sudo apt install git",
      autoFixAvailable: false,
    })
  }

  // Rust
  if (rustcVer) {
    checks.push({
      id: "runtime.rust",
      title: "Rust",
      category: "runtime",
      severity: "low",
      status: "pass",
      detected: rustcVer,
      expected: "latest (for FDX development)",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.rust",
      title: "Rust",
      category: "runtime",
      severity: "low",
      status: "info",
      detected: "not found",
      expected: "latest (for FDX development)",
      recommendation: "Install Rust for native FDX development: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      autoFixAvailable: false,
    })
  }

  // Python
  if (pyVer) {
    checks.push({
      id: "runtime.python",
      title: "Python",
      category: "runtime",
      severity: "low",
      status: "pass",
      detected: pyVer,
      expected: ">= 3.8",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.python",
      title: "Python",
      category: "runtime",
      severity: "low",
      status: "info",
      detected: "not found",
      expected: ">= 3.8",
      recommendation: "Install Python 3 for advanced scripting: sudo apt install python3",
      autoFixAvailable: false,
    })
  }

  // Docker
  if (dockerVer) {
    checks.push({
      id: "runtime.docker",
      title: "Docker",
      category: "runtime",
      severity: "low",
      status: "pass",
      detected: dockerVer,
      expected: "latest",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  } else {
    checks.push({
      id: "runtime.docker",
      title: "Docker",
      category: "runtime",
      severity: "low",
      status: "info",
      detected: "not found",
      expected: "latest",
      recommendation: "Install Docker for containerized workflows: https://docs.docker.com/get-docker/",
      autoFixAvailable: false,
    })
  }

  // WSL detection
  const isWSL = process.platform === "linux" && ((await tryExec("cat", ["/proc/version"])) || "").toLowerCase().includes("microsoft")
  checks.push({
    id: "runtime.wsl",
    title: "WSL2",
    category: "runtime",
    severity: "info",
    status: isWSL ? "pass" : "info",
    detected: isWSL ? "WSL2 detected" : "Not WSL",
    expected: "WSL2 on Windows recommended",
    recommendation: "Install WSL2: wsl --install -d Ubuntu-24.04",
    autoFixAvailable: false,
  })

  return checks
}
