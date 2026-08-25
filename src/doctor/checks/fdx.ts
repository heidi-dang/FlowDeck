import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { CheckResult } from "../types"
import { resolveFlowDeckPackageDir } from "../environment"

export async function runFdxChecks(directory: string): Promise<CheckResult[]> {
  const pkgDir = resolveFlowDeckPackageDir(directory)
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
  const hasTsFallback = existsSync(fdxTsFallbackPath) || existsSync(join(pkgDir, "dist", "index.js"))

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
      recommendation: "Build native FDX binary via `cargo build --manifest-path crates/fdx/Cargo.toml` or reinstall",
      autoFixAvailable: false,
      affectsRuntime: true,
      repairability: "manual",
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
      autoFixAvailable: false,
      affectsRuntime: true,
      repairability: "manual",
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

  // FDX Resident Native Daemon Health
  let daemonHealthy = false
  let daemonDetail = "FDX daemon not tested or spawned on demand"
  if (fdxRuns) {
    try {
      const execPath = nativeBinaryPath ?? "fdx"
      const { spawn } = await import("node:child_process")
      const cp = spawn(execPath, ["serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      const healthPromise = new Promise<boolean>((resolve) => {
        let healthResponded = false
        const timeout = setTimeout(() => {
          try { cp.kill("SIGKILL") } catch {}
          resolve(false)
        }, 1500)

        cp.on("close", () => {
          if (healthResponded) {
            clearTimeout(timeout)
            resolve(true)
          }
        })

        let buffer = ""
        cp.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8")
          const lines = buffer.split("\n")
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const res = JSON.parse(line)
              if (res.id === "health-check" && res.ok && res.value?.healthy) {
                healthResponded = true
                try { cp.kill("SIGTERM") } catch {}
                return
              }
            } catch {}
          }
        })

        cp.on("error", () => {
          clearTimeout(timeout)
          resolve(false)
        })

        try {
          cp.stdin?.write(JSON.stringify({ id: "health-check", op: "health" }) + "\n")
        } catch {
          clearTimeout(timeout)
          resolve(false)
        }
      })

      daemonHealthy = await healthPromise
      if (daemonHealthy) {
        daemonDetail = "FDX daemon spawns, accepts JSON-lines health request, responds validly, and shuts down cleanly"
      }
    } catch {
      daemonHealthy = false
    }
  }

  checks.push({
    id: "fdx.resident_daemon",
    title: "FDX Daemon Startup & IPC",
    category: "fdx",
    severity: "info",
    status: daemonHealthy ? "pass" : "info",
    detected: daemonDetail,
    expected: "FDX daemon spawns and responds to JSON-lines IPC",
    recommendation: daemonHealthy
      ? "FDX daemon capability verified (spawn → request → response → shutdown)"
      : "Daemon launches on demand when resident requests are made",
    autoFixAvailable: false,
    affectsRuntime: false,
    repairability: "not-applicable",
  })


  // ─── VCI Capability Contract Checks ────────────────────────────────────────
  // These checks validate FDX M1–M12 VCI integration readiness.
  // E3: Doctor must distinguish: healthy | degraded | unavailable | incompatible | corrupt

  if (fdxRuns && nativeBinaryPath) {
    // Check capabilities contract
    let capabilitiesOk = false
    let capabilitiesDetail = "FDX capabilities not queried"
    let protocolCompatible = false
    let graphSchemaCompatible = false
    let predicateV1 = false
    let predicateV2 = false
    let calibrationSupported = false
    let policySupported = false

    try {
      const capRaw = execFileSync(nativeBinaryPath, ["capabilities", "--format", "json"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      const cap = JSON.parse(capRaw) as Record<string, unknown>
      const contractVersion = cap["capability_contract_version"] as number

      if (contractVersion === 1) {
        capabilitiesOk = true
        const protocol = cap["fdx_protocol_version"] as number
        protocolCompatible = protocol === 1
        const graphSchema = cap["graph_schema"] as Record<string, unknown> | undefined
        graphSchemaCompatible =
          !!graphSchema &&
          (graphSchema["maximum_writable"] as number) >= 1 &&
          (graphSchema["can_read"] as boolean) === true &&
          (graphSchema["can_write"] as boolean) === true
        const predicates = (cap["verification_predicate_versions"] as string[]) ?? []
        predicateV1 = predicates.includes("v1")
        predicateV2 = predicates.includes("v2")
        const calibVersions = (cap["calibration_contract_versions"] as number[]) ?? []
        calibrationSupported = calibVersions.length > 0
        const policyVersions = (cap["policy_contract_versions"] as number[]) ?? []
        policySupported = policyVersions.length > 0
        capabilitiesDetail = `Contract v${contractVersion}, protocol v${protocol}, schema r/w, predicates: [${predicates.join(",")}]`
      } else {
        capabilitiesDetail = `Unsupported capability contract version ${contractVersion} (expected 1)`
      }
    } catch {
      capabilitiesDetail = "FDX capabilities query failed"
    }

    checks.push({
      id: "fdx.vci_capability_contract",
      title: "FDX VCI Capability Contract",
      category: "fdx",
      severity: capabilitiesOk ? "info" : "high",
      status: capabilitiesOk ? "pass" : "error",
      detected: capabilitiesDetail,
      expected: "FDX capability contract v1 with readable/writable graph schema",
      recommendation: capabilitiesOk
        ? "FDX VCI capability contract verified"
        : "Upgrade FDX binary or rebuild from crates/fdx/ to restore VCI capabilities",
      autoFixAvailable: false,
      affectsRuntime: !capabilitiesOk,
      repairability: capabilitiesOk ? "not-applicable" : "manual",
    })

    checks.push({
      id: "fdx.vci_protocol_compat",
      title: "FDX VCI Protocol Compatibility",
      category: "fdx",
      severity: protocolCompatible ? "info" : "medium",
      status: protocolCompatible ? "pass" : "warning",
      detected: protocolCompatible ? "Protocol v1 confirmed" : "Protocol version mismatch or unknown",
      expected: "FDX protocol version 1",
      recommendation: protocolCompatible
        ? "Protocol compatible"
        : "FDX binary may be outdated — rebuild from crates/fdx/",
      autoFixAvailable: false,
      affectsRuntime: !protocolCompatible,
      repairability: "manual",
    })

    checks.push({
      id: "fdx.vci_graph_schema",
      title: "FDX VCI Graph Schema",
      category: "fdx",
      severity: graphSchemaCompatible ? "info" : "high",
      status: graphSchemaCompatible ? "pass" : "error",
      detected: graphSchemaCompatible
        ? "Graph schema readable and writable"
        : "Graph schema incompatible or unavailable",
      expected: "Graph schema can_read=true, can_write=true, max_writable>=1",
      recommendation: graphSchemaCompatible
        ? "Graph schema compatible"
        : "Run `fdx index` to initialize the graph or rebuild FDX",
      autoFixAvailable: false,
      affectsRuntime: !graphSchemaCompatible,
      repairability: graphSchemaCompatible ? "not-applicable" : "manual",
    })

    checks.push({
      id: "fdx.vci_predicate_v1",
      title: "FDX VCI Predicate v1 (attestation)",
      category: "fdx",
      severity: predicateV1 ? "info" : "medium",
      status: predicateV1 ? "pass" : "warning",
      detected: predicateV1 ? "Predicate v1 supported" : "Predicate v1 not reported",
      expected: "Verification predicate v1 supported",
      recommendation: predicateV1 ? "Attestation v1 available" : "FDX binary may be outdated",
      autoFixAvailable: false,
      affectsRuntime: !predicateV1,
      repairability: "manual",
    })

    checks.push({
      id: "fdx.vci_predicate_v2",
      title: "FDX VCI Predicate v2 (policy attestation)",
      category: "fdx",
      severity: "info",
      status: predicateV2 ? "pass" : "info",
      detected: predicateV2 ? "Predicate v2 supported (policy-overlay attestation)" : "Predicate v2 not supported (normal — requires M11 policy)",
      expected: "Predicate v2 supported when policy overlay is available",
      recommendation: predicateV2
        ? "Policy-overlay attestation available"
        : "Predicate v2 becomes available after M11 policy promotion",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })

    checks.push({
      id: "fdx.vci_calibration",
      title: "FDX VCI M10 Calibration Contract",
      category: "fdx",
      severity: "info",
      status: calibrationSupported ? "pass" : "info",
      detected: calibrationSupported ? "Calibration contract supported" : "Calibration contract not available",
      expected: "M10 shadow calibration contract supported",
      recommendation: calibrationSupported
        ? "Shadow calibration will record qualified verification history"
        : "Calibration unavailable — M11 candidate generation disabled",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })

    checks.push({
      id: "fdx.vci_policy_contract",
      title: "FDX VCI M11 Policy Contract",
      category: "fdx",
      severity: "info",
      status: policySupported ? "pass" : "info",
      detected: policySupported ? "Policy contract supported" : "Policy contract not available",
      expected: "M11 learned-policy contract supported",
      recommendation: policySupported
        ? "ADD_CHECK policy overlay available when promoted policies exist"
        : "Policy overlay unavailable — base plan only",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  }

  // VCI VerificationService wiring check (TypeScript-level)
  const vciProviderPath = join(pkgDir, "dist", "index.js")
  const vciAdapterExists =
    existsSync(join(directory, "src", "services", "fdx-vci-adapter.ts")) ||
    existsSync(vciProviderPath)
  checks.push({
    id: "fdx.vci_adapter_wiring",
    title: "FDX VCI Adapter Wiring",
    category: "fdx",
    severity: vciAdapterExists ? "info" : "medium",
    status: vciAdapterExists ? "pass" : "warning",
    detected: vciAdapterExists ? "FDX VCI adapter present" : "FDX VCI adapter not found in build or source",
    expected: "src/services/fdx-vci-adapter.ts present",
    recommendation: vciAdapterExists
      ? "FDX VCI adapter wired"
      : "Rebuild FlowDeck to include VCI adapter",
    autoFixAvailable: false,
    affectsRuntime: !vciAdapterExists,
    repairability: "manual",
  })

  return checks
}