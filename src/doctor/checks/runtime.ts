/**
 * Runtime environment checks.
 */

import { execFileSync } from "child_process"
import type { CheckResult } from "../types"

function tryExec(cmd: string, args: string[] = []): string | null {
  try {
    const executable =
      process.platform === "win32" && (cmd === "npm" || cmd === "bun")
        ? `${cmd}.cmd`
        : cmd
    return execFileSync(executable, args, {
      encoding: "utf-8",
      timeout: 2000,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch { return null }
}

function tryVersion(cmd: string): string | null {
  const out = tryExec(cmd, ["--version"])
  return out?.split("\n")[0]?.trim() ?? null
}

export async function runRuntimeChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const nodeVer = tryVersion("node")
  const npmVer = tryVersion("npm")
  const bunVer = tryVersion("bun")
  const gitVer = tryVersion("git")
  const rustcVer = tryVersion("rustc")
  tryVersion("cargo")
  const pyVer = tryVersion("python3")
  const dockerVer = tryVersion("docker")

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
    checks.push({ id: "runtime.node", title: "Node.js", category: "runtime", severity: "high", status: "error", detected: "not found", expected: ">= 18.0.0", recommendation: "Install Node.js >= 18: https://nodejs.org", autoFixAvailable: false })
  }

  // npm
  if (npmVer) {
    checks.push({ id: "runtime.npm", title: "npm", category: "runtime", severity: "info", status: "pass", detected: npmVer, expected: "bundled with Node", recommendation: "OK", autoFixAvailable: false })
  }

  // Bun
  if (bunVer) {
    checks.push({ id: "runtime.bun", title: "Bun", category: "runtime", severity: "medium", status: "pass", detected: bunVer, expected: "latest", recommendation: "OK", autoFixAvailable: false })
  } else {
    checks.push({ id: "runtime.bun", title: "Bun", category: "runtime", severity: "medium", status: "warning", detected: "not found", expected: ">= 1.0.0", recommendation: "Install Bun: curl -fsSL https://bun.sh/install | bash", autoFixAvailable: false })
  }

  // Git
  if (gitVer) {
    checks.push({ id: "runtime.git", title: "Git", category: "runtime", severity: "high", status: "pass", detected: gitVer, expected: ">= 2.0.0", recommendation: "OK", autoFixAvailable: false })
  } else {
    checks.push({ id: "runtime.git", title: "Git", category: "runtime", severity: "high", status: "error", detected: "not found", expected: ">= 2.0.0", recommendation: "Install Git: sudo apt install git", autoFixAvailable: false })
  }

  // Rust
  if (rustcVer) {
    checks.push({ id: "runtime.rust", title: "Rust", category: "runtime", severity: "low", status: rustcVer ? "pass" : "info", detected: rustcVer || "not found", expected: "latest (for FDX development)", recommendation: "Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh", autoFixAvailable: false })
  }

  // Python
  if (pyVer) {
    checks.push({ id: "runtime.python", title: "Python", category: "runtime", severity: "low", status: "pass", detected: pyVer, expected: ">= 3.8", recommendation: "OK", autoFixAvailable: false })
  }

  // Docker
  if (dockerVer) {
    checks.push({ id: "runtime.docker", title: "Docker", category: "runtime", severity: "low", status: "pass", detected: dockerVer, expected: "latest", recommendation: "OK", autoFixAvailable: false })
  }

  // WSL detection
  const isWSL = process.platform === "linux" && (tryExec("cat", ["/proc/version"]) || "").toLowerCase().includes("microsoft")
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
