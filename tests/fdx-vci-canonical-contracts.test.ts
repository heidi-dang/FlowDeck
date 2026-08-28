/**
 * FDX VCI Canonical Contracts & Strict Parsing Tests
 *
 * Tests for Workstream A:
 * 1. Canonical runtime contracts (protocol=2, schema=10, calibration=2, policy=1, predicate v1/v2)
 * 2. Strict capability parser rejecting malformed, missing, future, or incompatible values
 * 3. Provider state hierarchy classification
 * 4. Doctor parity with canonical compatibility evaluation
 */

import { describe, it, expect } from "bun:test"
import {
  FDX_PROTOCOL_VERSION,
  FDX_GRAPH_SCHEMA_VERSION,
  FDX_GRAPH_SCHEMA_MIN_READABLE,
  FDX_CAPABILITY_CONTRACT_VERSION,
  FDX_CALIBRATION_CONTRACT_VERSION,
  FDX_POLICY_CONTRACT_VERSION,
  FDX_SELECTION_POLICY_VERSION,
  FDX_PREDICATE_VERSIONS,
  FDX_NETWORK_ACCESS,
  FDX_TELEMETRY,
  evaluateCapabilities,
} from "../src/services/fdx-vci-contracts"

describe("Canonical FDX M12 Contract Constants", () => {
  it("defines canonical protocol version 2", () => {
    expect(FDX_PROTOCOL_VERSION).toBe(2)
  })

  it("defines canonical graph schema version 10", () => {
    expect(FDX_GRAPH_SCHEMA_VERSION).toBe(10)
    expect(FDX_GRAPH_SCHEMA_MIN_READABLE).toBe(1)
  })

  it("defines canonical capability contract version 1", () => {
    expect(FDX_CAPABILITY_CONTRACT_VERSION).toBe(1)
  })

  it("defines canonical calibration contract version 2", () => {
    expect(FDX_CALIBRATION_CONTRACT_VERSION).toBe(2)
  })

  it("defines canonical policy contract version 1", () => {
    expect(FDX_POLICY_CONTRACT_VERSION).toBe(1)
  })

  it("defines canonical selection policy version 1", () => {
    expect(FDX_SELECTION_POLICY_VERSION).toBe(1)
  })

  it("defines predicate support for v1 and v2", () => {
    expect(FDX_PREDICATE_VERSIONS).toContain("v1")
    expect(FDX_PREDICATE_VERSIONS).toContain("v2")
  })

  it("enforces network_access=false and telemetry=false compile-time guarantees", () => {
    expect(FDX_NETWORK_ACCESS).toBe(false)
    expect(FDX_TELEMETRY).toBe(false)
  })
})

describe("Strict Capability Parsing & Provider Classification", () => {
  const validCanonicalCap = {
    capability_contract_version: 1,
    fdx_protocol_version: 2,
    graph_schema: {
      minimum_readable: 1,
      maximum_writable: 10,
      can_read: true,
      can_write: true,
      can_verify: true,
    },
    selection_policy_version: 1,
    verification_predicate_versions: ["v1", "v2"],
    calibration_contract_versions: [2],
    policy_contract_versions: [1],
    assurance_levels: ["EXACT", "CONSERVATIVE", "UNVERIFIED"],
    scip: { compiled_in: true, state: "local_optional" },
    tree_sitter: { compiled_in: true, state: "local_available" },
    native_execution: { available: true, mode: "local_process", limitations: [] },
    platform: "linux",
    platform_limitations: [],
    network_access: false,
    telemetry: false,
  }

  it("classifies fully valid M12 capability document as native_vci_full", () => {
    const res = evaluateCapabilities(validCanonicalCap, {
      policyOverlayEnabled: true,
      calibrationEnabled: true,
      requirePredicateV2: true,
    })
    expect(res.providerState).toBe("native_vci_full")
    expect(res.missingCapabilities).toEqual([])
    expect(res.parsed?.fdxProtocolVersion).toBe(2)
    expect(res.parsed?.graphSchemaMaxWritable).toBe(10)
  })

  it("rejects protocol version 1 as incompatible (Blocker 1)", () => {
    const proto1 = { ...validCanonicalCap, fdx_protocol_version: 1 }
    const res = evaluateCapabilities(proto1)
    expect(res.providerState).toBe("incompatible")
    expect(res.missingCapabilities).toContain("fdx_protocol_version")
    expect(res.reason).toContain("FDX protocol version 1 is not supported")
  })

  it("rejects capability contract version != 1 as incompatible", () => {
    const futureContract = { ...validCanonicalCap, capability_contract_version: 2 }
    const res = evaluateCapabilities(futureContract)
    expect(res.providerState).toBe("incompatible")
    expect(res.missingCapabilities).toContain("capability_contract_version")
  })

  it("rejects stale graph schema v9 as incompatible", () => {
    const schema9 = {
      ...validCanonicalCap,
      graph_schema: { ...validCanonicalCap.graph_schema, maximum_writable: 9 },
    }
    const res = evaluateCapabilities(schema9)
    expect(res.providerState).toBe("incompatible")
    expect(res.missingCapabilities).toContain("graph_schema.maximum_writable")
  })

  it("rejects newer unrecognized graph schema versions as incompatible", () => {
    const schema11 = {
      ...validCanonicalCap,
      graph_schema: { ...validCanonicalCap.graph_schema, maximum_writable: 11 },
    }
    const res = evaluateCapabilities(schema11)
    expect(res.providerState).toBe("incompatible")
    expect(res.missingCapabilities).toContain("graph_schema.maximum_writable")
  })

  it("fails closed when can_verify is missing or false", () => {
    const noVerify = {
      ...validCanonicalCap,
      graph_schema: { ...validCanonicalCap.graph_schema, can_verify: false },
    }
    const res = evaluateCapabilities(noVerify)
    expect(res.providerState).toBe("native_vci_partial")
    expect(res.missingCapabilities).toContain("graph_schema.can_verify")
  })

  it("fails closed when network_access or telemetry is true", () => {
    const withNetwork = { ...validCanonicalCap, network_access: true }
    const res1 = evaluateCapabilities(withNetwork)
    expect(res1.providerState).toBe("native_vci_partial")
    expect(res1.missingCapabilities).toContain("network_access_false")

    const withTelemetry = { ...validCanonicalCap, telemetry: true }
    const res2 = evaluateCapabilities(withTelemetry)
    expect(res2.providerState).toBe("native_vci_partial")
    expect(res2.missingCapabilities).toContain("telemetry_false")
  })

  it("fails closed on non-object or null input", () => {
    expect(evaluateCapabilities(null).providerState).toBe("unavailable")
    expect(evaluateCapabilities("bad json").providerState).toBe("unavailable")
    expect(evaluateCapabilities([]).providerState).toBe("unavailable")
  })

  it("demands calibration contract 2 when calibrationEnabled=true", () => {
    const noCalib2 = { ...validCanonicalCap, calibration_contract_versions: [1] }
    const res = evaluateCapabilities(noCalib2, { calibrationEnabled: true })
    expect(res.providerState).toBe("native_vci_partial")
    expect(res.missingCapabilities).toContain("calibration_contract_2")
  })

  it("demands policy contract 1 when policyOverlayEnabled=true", () => {
    const noPolicy1 = { ...validCanonicalCap, policy_contract_versions: [] }
    const res = evaluateCapabilities(noPolicy1, { policyOverlayEnabled: true })
    expect(res.providerState).toBe("native_vci_partial")
    expect(res.missingCapabilities).toContain("policy_contract_1")
  })
})
