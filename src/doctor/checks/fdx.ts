import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { CheckResult } from "../types"

export async function runFdxChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  const platformArchDir = `${process.platform}-${process.arch}`
  const binName = process.platform === "win32" ? "fdx.exe" : "fdx"

  const binaryCandidates = [
    join(directory, "native", "fdx", platformArchDir, binName),
    join(directory, "native", binName),
    join(directory, "crates", "fdx", "target", "release", binName),
  ]

  let nativeBinaryPath: string | null = null
  for (const cand of binaryCandidates) {
    if (existsSync(cand)) {
      try {
        if (statSync(cand).isFile()) {
          nativeBinaryPath = cand
          break
        }
      } catch {
        // ignore
      }
    }
  }

  let fdxRuns = false
  let fdxVersion = "unknown"

  if (nativeBinaryPath) {
    try {
      const out = execFileSync(nativeBinaryPath, ["--version"], { encoding: "utf-8", timeout: 3000 })
      fdxRuns = true
      fdxVersion = out.trim()
    } catch {
      fdxRuns = false
    }
  } else {
    // Try PATH fdx
    try {
      const out = execFileSync("fdx", ["--version"], { encoding: "utf-8", timeout: 3000 })
      fdxRuns = true
      fdxVersion = out.trim()
    } catch {
      fdxRuns = false
    }
  }

  // FDX TypeScript fallback check
  const fdxTsFallbackPath = join(directory, "src", "tools", "fdx-shared.ts")
  const hasTsFallback = existsSync(fdxTsFallbackPath)

  if (fdxRuns) {
    checks.push({
      id: "fdx.native_binary",
      title: "FDX Native Engine",
      category: "fdx",
      severity: "info",
      status: "pass",
      detected: `FDX binary functional (${fdxVersion})`,
      expected: "FDX binary available",
      recommendation: "Native FDX binary active",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  } else if (hasTsFallback) {
    checks.push({
      id: "fdx.native_binary",
      title: "FDX Native Engine",
      category: "fdx",
      severity: "medium",
      status: "warning",
      detected: "Native FDX binary missing or not executable (TS fallback active)",
      expected: "Native FDX binary executable",
      recommendation: "Run `flowdeck doctor fix` to restore or build native FDX binary",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "restore_fdx_binary",
    })
  } else {
    checks.push({
      id: "fdx.native_binary",
      title: "FDX Native Engine",
      category: "fdx",
      severity: "high",
      status: "error",
      detected: "Neither native FDX binary nor TS fallback found",
      expected: "FDX native binary or TS fallback available",
      recommendation: "Reinstall FlowDeck or build native FDX binary",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "restore_fdx_binary",
    })
  }

  // FDX Index & Cache Health
  const indexPath = join(directory, ".flowdeck", "fdx-index.json")
  if (existsSync(indexPath)) {
    checks.push({
      id: "fdx.index_cache",
      title: "FDX Index Cache",
      category: "fdx",
      severity: "info",
      status: "pass",
      detected: ".flowdeck/fdx-index.json present",
      expected: "FDX index cache present",
      recommendation: "FDX index cache operational",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  }

  return checks
}
