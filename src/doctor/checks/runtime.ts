/**
 * Runtime environment checks.
 */

import { execFile } from "child_process"
import { promisify } from "util"
import type { CheckResult } from "../types"
import { type FdxResolutionResult, getFdxAvailabilityStatus } from "../../tools/fdx-shared"

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

/**
 * Run the runtime environment checks.
 *
 * `opts.fdxStatus` injects the FDX availability result so unit tests of doctor
 * aggregation never run a real FDX resolution (which performs subprocess
 * probes and can be timing-sensitive). When omitted, the canonical resolver is
 * consulted (real integration path).
 */
export async function runRuntimeChecks(
  _directory: string,
  profileArg?: string,
  opts: { fdxStatus?: FdxResolutionResult } = {},
): Promise<CheckResult[]> {
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
  ] = await Promise.all([
    tryVersion("node"),
    tryVersion("npm"),
    tryVersion("bun"),
    tryVersion("git"),
    tryVersion("rustc"),
    tryVersion("cargo"),
    tryVersion("python3"),
    tryVersion("docker"),
  ])

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

  let fdxStatus: FdxResolutionResult
  if (opts?.fdxStatus) {
    // Injected (unit tests): doctor aggregation must not run a real FDX
    // resolution. Real resolver timing is covered by dedicated integration
    // tests under explicit bounded timeouts.
    fdxStatus = opts.fdxStatus
  } else {
    fdxStatus = getFdxAvailabilityStatus(true)
  }
  const profile = profileArg || process.env.FLOWDECK_PROFILE || "recommended-dev"
  const isStrictFail = profile !== "minimal"

  // 1. fdx.target-supported
  checks.push({
    id: "fdx.target-supported",
    title: "FDX Platform Target Support",
    category: "runtime",
    severity: "info",
    status: fdxStatus.targetSupported ? "pass" : "info",
    detected: fdxStatus.target ? `${fdxStatus.target.platform}/${fdxStatus.target.arch}${fdxStatus.target.libc ? ` (${fdxStatus.target.libc})` : ""}` : `${process.platform}/${process.arch} (unsupported for native package)`,
    expected: "Supported platform target",
    recommendation: fdxStatus.targetSupported ? "OK" : "Target uses TypeScript fallback by design",
    autoFixAvailable: false,
  })

  // 2. fdx.package-present
  checks.push({
    id: "fdx.package-present",
    title: "FDX Platform Package Present",
    category: "runtime",
    severity: isStrictFail ? "high" : "medium",
    status: fdxStatus.packagePresent ? "pass" : (fdxStatus.targetSupported ? (isStrictFail ? "error" : "warning") : "pass"),
    detected: fdxStatus.packagePresent ? `Package ${fdxStatus.target?.packageName} resolved` : "Optional package missing",
    expected: fdxStatus.target?.packageName ?? "n/a",
    recommendation: fdxStatus.packagePresent ? "OK" : "Run 'flowdeck fdx repair' or install optionalDependencies",
    autoFixAvailable: true,
  })

  // 3. fdx.binary-present
  checks.push({
    id: "fdx.binary-present",
    title: "FDX Native Binary Present",
    category: "runtime",
    severity: isStrictFail ? "high" : "medium",
    status: fdxStatus.binaryPresent ? "pass" : (fdxStatus.targetSupported ? (isStrictFail ? "error" : "warning") : "pass"),
    detected: fdxStatus.binaryPath ? `Binary at "${fdxStatus.binaryPath}" (${fdxStatus.source})` : "No binary found",
    expected: fdxStatus.target?.executableName ?? "fdx",
    recommendation: fdxStatus.binaryPresent ? "OK" : "Run 'flowdeck fdx repair'",
    autoFixAvailable: true,
  })

  // 4. fdx.binary-integrity
  checks.push({
    id: "fdx.binary-integrity",
    title: "FDX Binary Checksum Integrity",
    category: "runtime",
    severity: "high",
    status: fdxStatus.checksumStatus === "fail" ? "error" : "pass",
    detected: `Checksum status: ${fdxStatus.checksumStatus}`,
    expected: "SHA-256 matches manifest",
    recommendation: fdxStatus.checksumStatus === "fail" ? "Corrupt binary — run 'flowdeck fdx repair'" : "OK",
    autoFixAvailable: true,
  })

  // 5. fdx.binary-version
  checks.push({
    id: "fdx.binary-version",
    title: "FDX Binary Version Compatibility",
    category: "runtime",
    severity: "high",
    status: fdxStatus.versionCompatible ? "pass" : (fdxStatus.available ? "error" : (isStrictFail ? "error" : "warning")),
    detected: fdxStatus.binaryVersion ? `v${fdxStatus.binaryVersion}` : "none",
    expected: ">= 1.0.0",
    recommendation: fdxStatus.versionCompatible ? "OK" : "Run 'flowdeck fdx repair'",
    autoFixAvailable: true,
  })

  // 6. fdx.binary-execution
  checks.push({
    id: "fdx.binary-execution",
    title: "FDX Native Binary Execution",
    category: "runtime",
    severity: isStrictFail ? "high" : "medium",
    status: fdxStatus.executionStatus === "pass" ? "pass" : (fdxStatus.targetSupported ? (isStrictFail ? "error" : "warning") : "pass"),
    detected: fdxStatus.executionStatus,
    expected: "pass",
    recommendation: fdxStatus.executionStatus === "pass" ? "OK" : "Run 'flowdeck fdx repair'",
    autoFixAvailable: true,
  })

  // 7. fdx.fallback-available
  checks.push({
    id: "fdx.fallback-available",
    title: "FDX TypeScript Fallback Availability",
    category: "runtime",
    severity: "info",
    status: "pass",
    detected: fdxStatus.available ? "Inactive (native mode active)" : "Active (TypeScript fallback mode)",
    expected: "TypeScript fallback available for unsupported platforms or recovery",
    recommendation: "OK",
    autoFixAvailable: false,
  })

  return checks
}
