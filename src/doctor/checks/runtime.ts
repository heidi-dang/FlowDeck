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
  return parsed.major > 1 || (parsed.major === 1 && (parsed.minor > 18 || (parsed.minor === 18 && parsed.patch >= 18)))
}

export function supportsCodeMode(version: string | null): boolean {
  const parsed = parseOpenCodeVersion(version)
  if (!parsed) return false
  return parsed.major > 1 || (parsed.major === 1 && (parsed.minor > 18 || (parsed.minor === 18 && parsed.patch >= 18)))
}

export type OpenCodeCompatibilityStatus = "FULLY_QUALIFIED" | "RECOMMENDED" | "SUPPORTED" | "DEGRADED" | "UNSUPPORTED"

export function classifyOpenCodeCompatibility(opencodeVersion: string | null): {
  status: OpenCodeCompatibilityStatus
  qualification: "FULLY_QUALIFIED" | "RECOMMENDED" | "SUPPORTED" | "DEGRADED" | "UNSUPPORTED"
  details: string
} {
  const parsed = parseOpenCodeVersion(opencodeVersion)
  if (!parsed) {
    return {
      status: "UNSUPPORTED",
      qualification: "UNSUPPORTED",
      details: "OpenCode runtime not detected",
    }
  }

  // Exact target: 1.18.20 is FULLY_QUALIFIED and RECOMMENDED
  if (parsed.major === 1 && parsed.minor === 18 && parsed.patch === 20) {
    return {
      status: "FULLY_QUALIFIED",
      qualification: "FULLY_QUALIFIED",
      details: "OpenCode v1.18.20 (Authoritative Qualification Target)",
    }
  }

  // 1.18.18..1.18.19 are SUPPORTED
  if (parsed.major === 1 && parsed.minor === 18 && parsed.patch >= 18) {
    return {
      status: "SUPPORTED",
      qualification: "SUPPORTED",
      details: `OpenCode v${parsed.major}.${parsed.minor}.${parsed.patch} (Supported baseline; recommended: 1.18.20)`,
    }
  }

  // Newer minor versions >= 1.19
  if (parsed.major > 1 || (parsed.major === 1 && parsed.minor > 18)) {
    return {
      status: "SUPPORTED",
      qualification: "SUPPORTED",
      details: `OpenCode v${parsed.major}.${parsed.minor}.${parsed.patch} (Forward compatible)`,
    }
  }

  // 1.18.0..1.18.17 are DEGRADED (missing native Task child error & robust background subagents)
  if (parsed.major === 1 && parsed.minor === 18) {
    return {
      status: "DEGRADED",
      qualification: "DEGRADED",
      details: `OpenCode v${parsed.major}.${parsed.minor}.${parsed.patch} (Degraded: upgrade to >= 1.18.18, recommended 1.18.20)`,
    }
  }

  return {
    status: "UNSUPPORTED",
    qualification: "UNSUPPORTED",
    details: `OpenCode v${parsed.major}.${parsed.minor}.${parsed.patch} (< 1.18.0 unsupported)`,
  }
}

export function openCodeCompatibilityCheck(opencodeVersion: string | null): CheckResult {
  const compat = classifyOpenCodeCompatibility(opencodeVersion)

  let status: "pass" | "warning" | "error" | "info" = "info"
  let severity: "critical" | "high" | "medium" | "low" | "info" = "info"
  let recommendation = "Install OpenCode 1.18.20: https://opencode.ai"

  if (!opencodeVersion) {
    status = "info"
    severity = "info"
    recommendation = "Install OpenCode >= 1.18.18 (recommended: 1.18.20): https://opencode.ai"
  } else if (compat.qualification === "FULLY_QUALIFIED") {
    status = "pass"
    severity = "info"
    recommendation = "OpenCode runtime is fully qualified and aligned (v1.18.20)"
  } else if (compat.qualification === "SUPPORTED") {
    status = "pass"
    severity = "info"
    recommendation = "Supported version. Upgrade to 1.18.20 for exact qualification alignment"
  } else if (compat.qualification === "DEGRADED") {
    status = "warning"
    severity = "medium"
    recommendation = "Upgrade OpenCode to 1.18.20 for native Task child failure detection and background orchestration"
  } else {
    status = "error"
    severity = "high"
    recommendation = "Upgrade OpenCode to >= 1.18.18 (recommended: 1.18.20)"
  }

  return {
    id: "runtime.opencode_compatibility",
    title: "OpenCode Compatibility & Qualification",
    category: "runtime",
    severity,
    status,
    detected: compat.details,
    evidence: {
      runtimeVersion: opencodeVersion,
      qualification: compat.qualification,
      minimumSupported: "1.18.18",
      recommended: "1.18.20",
      fullyQualified: "1.18.20",
    },
    expected: "OpenCode >= 1.18.18 (recommended/qualified: 1.18.20)",
    recommendation,
    autoFixAvailable: false,
    affectsRuntime: true,
    repairability: "manual",
  }
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
  let recommendation = "Install OpenCode >= 1.18.18 (recommended 1.18.20): https://opencode.ai"
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
      recommendation = "Upgrade OpenCode to >= 1.18.18 (recommended 1.18.20) for native background subagent support"
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
    expected: "OpenCode >= 1.18.18 with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true",
    recommendation,
    autoFixAvailable,
    affectsRuntime: true,
    repairability,
  }
}

export function codeModeCapabilityCheck(opencodeVersion: string | null): CheckResult {
  const narrowFlag = process.env.OPENCODE_EXPERIMENTAL_CODE_MODE
  const broadFlag = process.env.OPENCODE_EXPERIMENTAL
  const nativeSupport = supportsCodeMode(opencodeVersion)
  const narrowEnabled = narrowFlag === "true"
  const broadEnabled = narrowFlag === undefined && broadFlag === "true"
  const enabled = narrowFlag === undefined ? broadEnabled : narrowEnabled

  let status: "pass" | "warning" | "error" | "info" = "info"
  let severity: "critical" | "high" | "medium" | "low" | "info" = "info"
  let recommendation = "Install OpenCode >= 1.18.18: https://opencode.ai"

  let detected = "OpenCode runtime not found (optional in CLI/standalone mode)"
  if (opencodeVersion) {
    detected = `${opencodeVersion}; native Code Mode (execute tool) ${nativeSupport ? "supported" : "not supported"}`
    if (narrowEnabled) detected += "; OPENCODE_EXPERIMENTAL_CODE_MODE=true"
    else if (broadEnabled) detected += "; enabled through broad OPENCODE_EXPERIMENTAL fallback"
    else detected += "; OPENCODE_EXPERIMENTAL_CODE_MODE is disabled"

    if (!nativeSupport) {
      status = "info"
      severity = "info"
      recommendation = "Upgrade OpenCode to >= 1.18.18 (recommended 1.18.20) for experimental native Code Mode"
    } else if (enabled) {
      status = "pass"
      severity = "info"
      recommendation = "OpenCode native Code Mode enabled (execute tool active for eligible MCP tools)"
    } else {
      status = "info"
      severity = "info"
      recommendation = "Enable OPENCODE_EXPERIMENTAL_CODE_MODE=true to allow Heidi to compose eligible MCP tool calls via native execute"
    }
  }

  return {
    id: "runtime.opencode_code_mode",
    title: "OpenCode Native Code Mode",
    category: "runtime",
    severity,
    status,
    detected,
    evidence: {
      runtimeVersion: opencodeVersion,
      nativeSupport,
      featureEnabled: enabled,
      executeToolAvailable: nativeSupport && enabled,
      narrowFlag: narrowFlag ?? null,
      broadFlag: broadFlag ?? null,
      mcpOnlyBoundary: true,
    },
    expected: "OPENCODE_EXPERIMENTAL_CODE_MODE=true (optional capability)",
    recommendation,
    autoFixAvailable: false,
    affectsRuntime: false,
    repairability: "not-applicable",
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

  checks.push(openCodeCompatibilityCheck(opencodeVer))
  checks.push(backgroundSubagentCapabilityCheck(opencodeVer))
  checks.push(codeModeCapabilityCheck(opencodeVer))

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
