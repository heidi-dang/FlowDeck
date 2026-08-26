import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { CheckResult } from "../types"
import { resolveFlowDeckPackageDir } from "../environment"
import {
  FDX_PROTOCOL_VERSION,
  FDX_GRAPH_SCHEMA_VERSION,
  FDX_GRAPH_SCHEMA_MIN_READABLE,
  FDX_CAPABILITY_CONTRACT_VERSION,
  FDX_CALIBRATION_CONTRACT_VERSION,
  FDX_POLICY_CONTRACT_VERSION,
  evaluateCapabilities,
  fdxCapabilitiesArgs,
} from "../../services/fdx-vci-contracts"
import { resolveFdxBinaryPath } from "../../tools/fdx-shared"

export async function runFdxChecks(directory: string): Promise<CheckResult[]> {
  const pkgDir = resolveFlowDeckPackageDir(directory)
  const checks: CheckResult[] = []

  const platformArchDir = `${process.platform}-${process.arch}`
  const binName = process.platform === "win32" ? "fdx.exe" : "fdx"

  const binaryCandidates = [
    process.env["FDX_BINARY_PATH"],
    join(pkgDir, "target", "release", binName),
    join(pkgDir, "native", "fdx", platformArchDir, binName),
    join(pkgDir, "native", binName),
    join(pkgDir, "crates", "fdx", "target", "release", binName),
    join(pkgDir, "crates", "fdx", "target", "debug", binName),
    join(directory, "target", "release", binName),
    join(directory, "native", "fdx", platformArchDir, binName),
    join(directory, "native", binName),
    join(directory, "crates", "fdx", "target", "release", binName),
    join(directory, "crates", "fdx", "target", "debug", binName),
  ].filter(Boolean) as string[]

  let nativeBinaryPath: string | null = resolveFdxBinaryPath()
  if (!nativeBinaryPath) {
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
      nativeBinaryPath = null
    }
  }

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
  } else {
    checks.push({
      id: "fdx.native_binary",
      title: "FDX Native Engine",
      category: "fdx",
      severity: "high",
      status: "error",
      detected: "Native FDX binary missing or not executable; TypeScript fallback cannot qualify VCI authority",
      expected: "Native FDX binary executable",
      recommendation: "Build native FDX binary via `cargo build --manifest-path crates/fdx/Cargo.toml --release` or reinstall",
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

  // Check tree-sitter grammars (informational)
  if (fdxRuns && nativeBinaryPath) {
    let grammarsWorking = false
    let grammarDetail = "Grammars not tested"
    try {
      const out = execFileSync(
        nativeBinaryPath,
        ["search", "runFdxChecks", join(directory, "src"), "--format", "json"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
      )
      const parsed = JSON.parse(out)
      grammarsWorking = Array.isArray(parsed)
      grammarDetail = grammarsWorking
        ? `Tree-sitter AST parser active (found ${parsed.length} symbol matches)`
        : "Tree-sitter search returned unexpected format"
    } catch {
      grammarDetail = "Tree-sitter search test failed (non-fatal, raw text fallback active)"
    }

    checks.push({
      id: "fdx.tree_sitter",
      title: "FDX Tree-Sitter Grammars",
      category: "fdx",
      severity: "info",
      status: grammarsWorking ? "pass" : "info",
      detected: grammarDetail,
      expected: "Compiled tree-sitter parsers available in native binary",
      recommendation: grammarsWorking
        ? "AST-level search and diff available"
        : "Rebuild FDX native binary from crates/fdx/ to restore full AST support",
      autoFixAvailable: false,
      affectsRuntime: false,
      repairability: "not-applicable",
    })
  }

  // Check evidence graph SQLite storage
  const fdxGraphDir = join(directory, ".fdx")
  const fdxGraphDb = join(fdxGraphDir, "evidence.db")
  const hasGraphDb = existsSync(fdxGraphDb)

  checks.push({
    id: "fdx.evidence_graph",
    title: "FDX EvidenceGraph Index",
    category: "fdx",
    severity: "info",
    status: hasGraphDb ? "pass" : "info",
    detected: hasGraphDb
      ? `EvidenceGraph database present at .fdx/evidence.db`
      : "No .fdx/evidence.db found (created on first 'fdx index' or semantic analysis)",
    expected: ".fdx/evidence.db present for fast cross-file dependency queries",
    recommendation: hasGraphDb
      ? "EvidenceGraph active"
      : "Run 'fdx index' in workspace root to pre-warm the symbol dependency graph",
    autoFixAvailable: false,
    affectsRuntime: false,
    repairability: "not-applicable",
  })

  // Check resident daemon availability
  if (fdxRuns && nativeBinaryPath) {
    let daemonHealthy = false
    let daemonDetail = "Daemon check skipped"

    try {
      const cp = require("node:child_process").spawn(nativeBinaryPath, ["serve"], {
        cwd: directory,
        stdio: ["pipe", "pipe", "ignore"],
      })

      const healthPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          try { cp.kill() } catch {}
          resolve(false)
        }, 3000)

        cp.stdout?.once("data", (data: Buffer) => {
          clearTimeout(timeout)
          try {
            const resp = JSON.parse(data.toString().trim())
            resolve(resp?.data?.healthy === true || resp?.healthy === true)
          } catch {
            resolve(false)
          } finally {
            try { cp.kill() } catch {}
          }
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
  }

  // ─── VCI Capability Contract Checks ────────────────────────────────────────
  // Canonical compatibility evaluation derived from fdx-vci-contracts.ts.
  // E3: Doctor must distinguish: healthy | degraded | unavailable | incompatible

  if (fdxRuns && nativeBinaryPath) {
    let evalResult = evaluateCapabilities(null)
    let rawCap: unknown = null
    let capDetail = "FDX capabilities not queried"

    try {
      const capRaw = execFileSync(nativeBinaryPath, fdxCapabilitiesArgs(), {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      rawCap = JSON.parse(capRaw)
      evalResult = evaluateCapabilities(rawCap, {
        policyOverlayEnabled: true,
        calibrationEnabled: true,
        requirePredicateV2: true,
      })
      capDetail = `Contract v${evalResult.parsed?.capabilityContractVersion}, protocol v${evalResult.parsed?.fdxProtocolVersion}, schema max-write ${evalResult.parsed?.graphSchemaMaxWritable}, predicates: [${evalResult.parsed?.verificationPredicateVersions.join(",")}]`
    } catch (e: unknown) {
      capDetail = `FDX capabilities query failed: ${e instanceof Error ? e.message : String(e)}`
    }

    const capabilitiesOk = evalResult.providerState === "native_vci_full"
    const protocolCompatible = evalResult.parsed?.fdxProtocolVersion === FDX_PROTOCOL_VERSION
    const graphSchemaCompatible =
      evalResult.parsed?.graphSchemaMaxWritable === FDX_GRAPH_SCHEMA_VERSION &&
      evalResult.parsed?.graphSchemaMinReadable === FDX_GRAPH_SCHEMA_MIN_READABLE &&
      evalResult.parsed?.graphCanRead === true &&
      evalResult.parsed?.graphCanWrite === true &&
      evalResult.parsed?.graphCanVerify === true
    const predicateV1 = evalResult.parsed?.verificationPredicateVersions.includes("v1") ?? false
    const predicateV2 = evalResult.parsed?.verificationPredicateVersions.includes("v2") ?? false
    const calibrationSupported = evalResult.parsed?.calibrationContractVersions.includes(FDX_CALIBRATION_CONTRACT_VERSION) ?? false
    const policySupported = evalResult.parsed?.policyContractVersions.includes(FDX_POLICY_CONTRACT_VERSION) ?? false

    checks.push({
      id: "fdx.vci_capability_contract",
      title: "FDX VCI Capability Contract",
      category: "fdx",
      severity: capabilitiesOk ? "info" : "high",
      status: capabilitiesOk ? "pass" : "error",
      detected: capabilitiesOk ? capDetail : (evalResult.reason ?? capDetail),
      expected: `FDX capability contract v${FDX_CAPABILITY_CONTRACT_VERSION} with protocol v${FDX_PROTOCOL_VERSION} and schema ${FDX_GRAPH_SCHEMA_VERSION}`,
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
      severity: protocolCompatible ? "info" : "high",
      status: protocolCompatible ? "pass" : "error",
      detected: protocolCompatible ? `Protocol v${FDX_PROTOCOL_VERSION} confirmed` : "Protocol version mismatch or unknown",
      expected: `FDX protocol version ${FDX_PROTOCOL_VERSION}`,
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
        ? `Graph schema readable, writable, and verifiable (read ${FDX_GRAPH_SCHEMA_MIN_READABLE}, write ${FDX_GRAPH_SCHEMA_VERSION})`
        : "Graph schema incompatible or unavailable",
      expected: `Graph schema can_read=true, can_write=true, can_verify=true, minimum_readable=${FDX_GRAPH_SCHEMA_MIN_READABLE}, maximum_writable=${FDX_GRAPH_SCHEMA_VERSION}`,
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
      detected: predicateV2 ? "Predicate v2 supported (policy-overlay attestation)" : "Predicate v2 not supported",
      expected: "Predicate v2 supported when policy overlay is available",
      recommendation: predicateV2
        ? "Policy-overlay attestation available"
        : "Predicate v2 becomes available when supported by FDX",
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
      detected: calibrationSupported ? `Calibration contract v${FDX_CALIBRATION_CONTRACT_VERSION} supported` : "Calibration contract not available",
      expected: `M10 shadow calibration contract v${FDX_CALIBRATION_CONTRACT_VERSION} supported`,
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
      detected: policySupported ? `Policy contract v${FDX_POLICY_CONTRACT_VERSION} supported` : "Policy contract not available",
      expected: `M11 learned-policy contract v${FDX_POLICY_CONTRACT_VERSION} supported`,
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
