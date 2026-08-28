/**
 * FDX VCI Canonical Contracts
 *
 * Single source of truth for all FDX VCI protocol, schema, and contract values.
 * Every version constant must derive from this module.
 *
 * These values MUST match the frozen Rust source in:
 *   crates/fdx/src/protocol.rs
 *   crates/fdx/src/intelligence/capabilities.rs
 *   crates/fdx/src/intelligence/calibration/model.rs
 *   crates/fdx/src/intelligence/policy/model.rs
 *
 * Rust constants (for cross-reference):
 *   FDX_PROTOCOL_VERSION              = 2
 *   FDX_GRAPH_SCHEMA_VERSION          = 10
 *   MINIMUM_READABLE_GRAPH_SCHEMA     = 1
 *   FDX_CAPABILITY_CONTRACT_VERSION   = 1
 *   CALIBRATION_CONTRACT_VERSION      = 2
 *   POLICY_CONTRACT_VERSION           = 1
 *   FDX_SELECTION_POLICY_VERSION      = 1
 *   Predicate versions                = ["v1", "v2"]
 *   network_access                    = false
 *   telemetry                         = false
 */

// ─── Frozen FDX M12 Protocol Constants ──────────────────────────────────────
// The generated artifact is derived from Rust source by
// scripts/generate-fdx-vci-contract.mjs. Heidi owns transport validation, not
// the protocol values themselves.

import { FDX_NATIVE_CONTRACT } from "../generated/fdx-vci-contract"

/** FDX JSON-lines IPC protocol version. Frozen at M12. */
export const FDX_PROTOCOL_VERSION = FDX_NATIVE_CONTRACT.protocolVersion

/** FDX EvidenceGraph SQLite schema version. Frozen at M12. */
export const FDX_GRAPH_SCHEMA_VERSION = FDX_NATIVE_CONTRACT.graphSchemaVersion

/** Minimum graph schema version this code can read. */
export const FDX_GRAPH_SCHEMA_MIN_READABLE = FDX_NATIVE_CONTRACT.graphSchemaMinimumReadable

/** Version of the local capability document used for authority-bearing negotiation. */
export const FDX_CAPABILITY_CONTRACT_VERSION = FDX_NATIVE_CONTRACT.capabilityContractVersion

/** M10 shadow calibration evidence contract version. */
export const FDX_CALIBRATION_CONTRACT_VERSION = FDX_NATIVE_CONTRACT.calibrationContractVersion

/** M11 learned-policy contract version. */
export const FDX_POLICY_CONTRACT_VERSION = FDX_NATIVE_CONTRACT.policyContractVersion

/** Selection/escalation algorithm policy version. */
export const FDX_SELECTION_POLICY_VERSION = FDX_NATIVE_CONTRACT.selectionPolicyVersion

/** Verification predicate versions produced by this FDX binary. */
export const FDX_PREDICATE_VERSIONS = FDX_NATIVE_CONTRACT.predicateVersions

/** FDX never makes network calls (compile-time guarantee). */
export const FDX_NETWORK_ACCESS = FDX_NATIVE_CONTRACT.networkAccess

/** FDX never reports telemetry (compile-time guarantee). */
export const FDX_TELEMETRY = FDX_NATIVE_CONTRACT.telemetry

// ─── Capability Classification Requirements ───────────────────────────────────
// These define what capability fields must be satisfied for each provider state.

export interface FdxRequiredCapabilities {
  /** Required for all native authority. */
  graphReadWrite: boolean
  /** Required for FDX-authoritative verification. */
  graphVerify: boolean
  /** Required when policy overlay is enabled. */
  policyContract: boolean
  /** Required when predicate v2 attestation needed. */
  predicateV2: boolean
  /** Required when calibration is enabled. */
  calibrationContract: boolean
}

/**
 * Evaluate a raw capability JSON response against the frozen M12 contracts.
 *
 * Returns a typed classification result including which capabilities are missing.
 * This function is the canonical compatibility check used by both adapter and doctor.
 *
 * Never returns native_vci_full when any required capability is absent, malformed,
 * or incompatible with the frozen M12 contract.
 */
export interface CapabilityEvaluationResult {
  /** Overall provider state classification. */
  providerState: "native_vci_full" | "native_vci_partial" | "typescript_fallback" | "unavailable" | "incompatible"
  /** Specific capabilities that are missing or incompatible. */
  missingCapabilities: string[]
  /** Human-readable reason for degraded/incompatible state. */
  reason?: string
  /** Parsed fields, only present when contract version matched. */
  parsed?: {
    capabilityContractVersion: number
    fdxProtocolVersion: number
    graphSchemaMinReadable: number
    graphSchemaMaxWritable: number
    graphCanRead: boolean
    graphCanWrite: boolean
    graphCanVerify: boolean
    selectionPolicyVersion: number
    verificationPredicateVersions: string[]
    calibrationContractVersions: number[]
    policyContractVersions: number[]
    assuranceLevels: string[]
    networkAccess: boolean
    telemetry: boolean
    platform: string
    platformLimitations: string[]
  }
}

/**
 * Strict capability contract evaluator.
 *
 * All decisions about native vs fallback MUST go through this function.
 * No caller may perform ad-hoc protocol version comparisons.
 *
 * Fail-closed: any ambiguity → not native_vci_full.
 */
export function evaluateCapabilities(
  raw: unknown,
  config: {
    policyOverlayEnabled?: boolean
    calibrationEnabled?: boolean
    requirePredicateV2?: boolean
  } = {}
): CapabilityEvaluationResult {
  const missing: string[] = []

  // Must be an object
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      providerState: "unavailable",
      missingCapabilities: ["capability_response"],
      reason: "Capability response is not a JSON object",
    }
  }
  const obj = raw as Record<string, unknown>

  // Step 1: Validate capability contract version FIRST.
  // Any unknown version must fail closed immediately.
  const contractVersion = obj["capability_contract_version"]
  if (typeof contractVersion !== "number" || contractVersion !== FDX_CAPABILITY_CONTRACT_VERSION) {
    return {
      providerState: "incompatible",
      missingCapabilities: ["capability_contract_version"],
      reason: `Capability contract version ${String(contractVersion)} is not supported (expected ${FDX_CAPABILITY_CONTRACT_VERSION}). Fail closed.`,
    }
  }

  // Step 2: Validate protocol version.
  const protocolVersion = obj["fdx_protocol_version"]
  if (typeof protocolVersion !== "number" || protocolVersion !== FDX_PROTOCOL_VERSION) {
    return {
      providerState: "incompatible",
      missingCapabilities: ["fdx_protocol_version"],
      reason: `FDX protocol version ${String(protocolVersion)} is not supported (expected ${FDX_PROTOCOL_VERSION}). Fail closed.`,
    }
  }

  // Step 3: Validate graph schema
  const graphSchema = obj["graph_schema"]
  if (!graphSchema || typeof graphSchema !== "object" || Array.isArray(graphSchema)) {
    return {
      providerState: "incompatible",
      missingCapabilities: ["graph_schema"],
      reason: "graph_schema field missing or malformed",
    }
  }
  const gs = graphSchema as Record<string, unknown>
  const maxWritable = gs["maximum_writable"]
  const minReadable = gs["minimum_readable"]
  const canRead = gs["can_read"]
  const canWrite = gs["can_write"]
  const canVerify = gs["can_verify"]

  if (typeof maxWritable !== "number" || maxWritable !== FDX_GRAPH_SCHEMA_VERSION) {
    return {
      providerState: "incompatible",
      missingCapabilities: ["graph_schema.maximum_writable"],
      reason: `Graph schema maximum_writable ${String(maxWritable)} is not supported (expected ${FDX_GRAPH_SCHEMA_VERSION}). Fail closed.`,
    }
  }
  if (typeof minReadable !== "number" || minReadable !== FDX_GRAPH_SCHEMA_MIN_READABLE) {
    return {
      providerState: "incompatible",
      missingCapabilities: ["graph_schema.minimum_readable"],
      reason: `Graph schema minimum_readable ${String(minReadable)} is not supported (expected ${FDX_GRAPH_SCHEMA_MIN_READABLE}). Fail closed.`,
    }
  }
  if (canRead !== true) missing.push("graph_schema.can_read")
  if (canWrite !== true) missing.push("graph_schema.can_write")
  if (canVerify !== true) missing.push("graph_schema.can_verify")

  // Step 4: Predicate versions
  const predicates = obj["verification_predicate_versions"]
  if (!Array.isArray(predicates)) {
    missing.push("verification_predicate_versions")
  } else {
    if (!predicates.includes("v1")) missing.push("predicate_v1")
    if (config.requirePredicateV2 && !predicates.includes("v2")) missing.push("predicate_v2")
  }

  // Step 5: Calibration contract
  const calibVersions = obj["calibration_contract_versions"]
  if (!Array.isArray(calibVersions)) {
    missing.push("calibration_contract_versions")
  } else if (config.calibrationEnabled && !calibVersions.includes(FDX_CALIBRATION_CONTRACT_VERSION)) {
    missing.push(`calibration_contract_${FDX_CALIBRATION_CONTRACT_VERSION}`)
  }

  // Step 6: Policy contract
  const policyVersions = obj["policy_contract_versions"]
  if (!Array.isArray(policyVersions)) {
    missing.push("policy_contract_versions")
  } else if (config.policyOverlayEnabled && !policyVersions.includes(FDX_POLICY_CONTRACT_VERSION)) {
    missing.push(`policy_contract_${FDX_POLICY_CONTRACT_VERSION}`)
  }

  // Step 7: Network and telemetry — FDX must not make network calls
  if (obj["network_access"] !== false) missing.push("network_access_false")
  if (obj["telemetry"] !== false) missing.push("telemetry_false")

  // Step 8: Selection policy version
  const selectionPolicy = obj["selection_policy_version"]
  if (typeof selectionPolicy !== "number" || selectionPolicy !== FDX_SELECTION_POLICY_VERSION) {
    missing.push("selection_policy_version")
  }

  // Build parsed output
  const parsed: CapabilityEvaluationResult["parsed"] = {
    capabilityContractVersion: contractVersion,
    fdxProtocolVersion: protocolVersion,
    graphSchemaMinReadable: typeof minReadable === "number" ? minReadable : 0,
    graphSchemaMaxWritable: typeof maxWritable === "number" ? maxWritable : 0,
    graphCanRead: canRead === true,
    graphCanWrite: canWrite === true,
    graphCanVerify: canVerify === true,
    selectionPolicyVersion: typeof selectionPolicy === "number" ? selectionPolicy : 0,
    verificationPredicateVersions: Array.isArray(predicates) ? predicates.filter(p => typeof p === "string") : [],
    calibrationContractVersions: Array.isArray(calibVersions) ? calibVersions.filter(v => typeof v === "number") : [],
    policyContractVersions: Array.isArray(policyVersions) ? policyVersions.filter(v => typeof v === "number") : [],
    assuranceLevels: Array.isArray(obj["assurance_levels"]) ? (obj["assurance_levels"] as unknown[]).filter(v => typeof v === "string") as string[] : [],
    networkAccess: obj["network_access"] === true,
    telemetry: obj["telemetry"] === true,
    platform: typeof obj["platform"] === "string" ? obj["platform"] : "unknown",
    platformLimitations: Array.isArray(obj["platform_limitations"]) ? (obj["platform_limitations"] as unknown[]).filter(v => typeof v === "string") as string[] : [],
  }

  const providerState = missing.length === 0
    ? "native_vci_full"
    : "native_vci_partial"

  return {
    providerState,
    missingCapabilities: missing,
    parsed,
    reason: missing.length > 0 ? `Missing capabilities: ${missing.join(", ")}` : undefined,
  }
}

/**
 * Format a human-readable capability summary for doctor output.
 */
export function formatCapabilitySummary(result: CapabilityEvaluationResult): string {
  if (!result.parsed) return result.reason ?? "No capability data"
  const p = result.parsed
  return [
    `Contract v${p.capabilityContractVersion}`,
    `protocol v${p.fdxProtocolVersion}`,
    `schema ${p.graphSchemaMinReadable}...${p.graphSchemaMaxWritable} (r:${p.graphCanRead} w:${p.graphCanWrite} v:${p.graphCanVerify})`,
    `predicates: [${p.verificationPredicateVersions.join(",")}]`,
    `calibration: [${p.calibrationContractVersions.join(",")}]`,
    `policy: [${p.policyContractVersions.join(",")}]`,
  ].join(", ")
}

// ─── FDX CLI argument builders ────────────────────────────────────────────────
// Canonical arguments for invoking the FDX CLI. Use these everywhere.

/** Build args for: fdx capabilities --format json */
export function fdxCapabilitiesArgs(): string[] {
  return ["capabilities", "--format", "json"]
}

/** Build args for: fdx plan [--base <ref>] [--head <ref>] [--policy-overlay] --format json */
export function fdxPlanArgs(opts: {
  base?: string
  head?: string
  policyOverlay?: boolean
}): string[] {
  const args = ["plan", "--format", "json"]
  if (opts.base) args.push("--base", opts.base)
  if (opts.head) args.push("--head", opts.head)
  if (opts.policyOverlay) args.push("--policy-overlay")
  return args
}

/** Build args for: fdx verify [--base <ref>] [--head <ref>] [--policy-overlay] [--fail-fast] --format json */
export function fdxVerifyArgs(opts: {
  base?: string
  head?: string
  policyOverlay?: boolean
  failFast?: boolean
  noPersist?: boolean
}): string[] {
  const args = ["verify", "--format", "json"]
  if (opts.base) args.push("--base", opts.base)
  if (opts.head) args.push("--head", opts.head)
  if (opts.policyOverlay) args.push("--policy-overlay")
  if (opts.failFast) args.push("--fail-fast")
  if (opts.noPersist) args.push("--no-persist")
  return args
}

/** Build args for: fdx attest create --run <id> --predicate-version <v1|v2> --format json */
export function fdxAttestCreateArgs(runId: string, predicateVersion: "v1" | "v2"): string[] {
  return ["attest", "create", "--run", runId, "--predicate-version", predicateVersion, "--format", "json"]
}

/** Build args for: fdx attest verify <file> --format json */
export function fdxAttestVerifyArgs(attestationFile: string, expectedSha256?: string): string[] {
  const args = ["attest", "verify", attestationFile, "--format", "json"]
  if (expectedSha256) args.push("--expected-sha256", expectedSha256)
  return args
}

/** Build args for: fdx runtime ingest --run <id> --format json */
export function fdxRuntimeIngestArgs(runId: string): string[] {
  return ["runtime", "ingest", "--run", runId, "--format", "json"]
}

/** Build args for: fdx runtime show --run <id> --format json */
export function fdxRuntimeShowArgs(runId: string): string[] {
  return ["runtime", "show", "--run", runId, "--format", "json"]
}

/** Build args for: fdx calibrate run --run <id> --format json */
export function fdxCalibrateArgs(runId: string, opts?: { maxChecks?: number; maxDurationMs?: number }): string[] {
  const args = ["calibrate", "run", "--run", runId, "--format", "json"]
  if (opts?.maxChecks) args.push("--max-checks", String(opts.maxChecks))
  if (opts?.maxDurationMs) args.push("--max-duration-ms", String(opts.maxDurationMs))
  return args
}

/** Build args for: fdx impact-v2 [--base <ref>] [--head <ref>] --format json */
export function fdxImpactV2Args(opts: { base?: string; head?: string; depth?: number }): string[] {
  const args = ["impact-v2", "--format", "json"]
  if (opts.base) args.push("--base", opts.base)
  if (opts.head) args.push("--head", opts.head)
  if (opts.depth != null) args.push("--depth", String(opts.depth))
  return args
}
