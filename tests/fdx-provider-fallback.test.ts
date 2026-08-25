/**
 * FDX Provider Fallback Tests
 *
 * B4: Native-first hierarchy with fallback semantics
 * B6: Simple task bypass
 * E6: Backward compat when FDX absent
 * E8: No FDX overuse
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  queryFdxCapabilities,
  invalidateFdxCapabilitySnapshot,
  classifyTaskMutation,
} from "../src/services/fdx-vci-adapter"

const ABSENT_BINARY = "/tmp/fdx-not-found-" + Date.now()
const WS = "/tmp/fallback-test-ws-" + Date.now()

function setAbsentBinary() {
  process.env.FDX_BINARY_PATH = ABSENT_BINARY
}

function restoreEnv(orig: string | undefined) {
  if (orig !== undefined) process.env.FDX_BINARY_PATH = orig
  else delete process.env.FDX_BINARY_PATH
}

describe("Native-first provider hierarchy", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    setAbsentBinary()
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    restoreEnv(origEnv)
  })

  it("uses typescript_fallback when binary not found", async () => {
    const snap = await queryFdxCapabilities(WS)
    expect(snap.providerState).toBe("typescript_fallback")
    expect(snap.binaryPath).toBeUndefined()
  })

  it("typescript_fallback is explicitly typed, not native", async () => {
    const snap = await queryFdxCapabilities(WS)
    expect(snap.providerState).not.toBe("native_vci_full")
    expect(snap.providerState).not.toBe("native_vci_partial")
  })

  it("does not crash when FDX binary absent", async () => {
    const snap = await queryFdxCapabilities(WS)
    expect(snap).toBeDefined()
    expect(snap.providerState).toBe("typescript_fallback")
  })

  it("provider state model is a string type, not boolean", async () => {
    const snap = await queryFdxCapabilities(WS)
    const validStates = ["native_vci_full", "native_vci_partial", "typescript_fallback", "unavailable"]
    expect(validStates).toContain(snap.providerState)
    expect(typeof snap.providerState).toBe("string")
  })
})

describe("Simple task bypass — no unnecessary FDX lifecycle", () => {
  it("node version question is NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("what version of Node is this repo using?", {})).toBe("NO_REPO_MUTATION")
  })

  it("rename a file without hasFileChanges is NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("rename the config file", {})).toBe("NO_REPO_MUTATION")
  })

  it("answer a question is NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("what does this function do?", {})).toBe("NO_REPO_MUTATION")
  })

  it("read configuration is NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("read the configuration file", {})).toBe("NO_REPO_MUTATION")
  })

  it("install command with no file changes is NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("install latest opencode", {})).toBe("NO_REPO_MUTATION")
  })

  it("simple file mutation triggers lightweight workflow, not high-risk", () => {
    const result = classifyTaskMutation("add a comment to this function", {
      hasFileChanges: true,
      changedFileCount: 1,
    })
    expect(result).toBe("SIMPLE_REPO_MUTATION")
    expect(result).not.toBe("HIGH_RISK_REPO_MUTATION")
  })
})

describe("Backward compat when FDX absent", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    setAbsentBinary()
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    restoreEnv(origEnv)
  })

  it("does not throw when capabilities query cannot find binary", async () => {
    await expect(queryFdxCapabilities(WS)).resolves.toBeDefined()
  })

  it("returns typed degraded snapshot instead of crashing", async () => {
    const snap = await queryFdxCapabilities(WS)
    expect(snap.providerState).toBe("typescript_fallback")
    expect(snap.snapshotId).toBeTruthy()
    expect(snap.capturedAt).toBeTruthy()
  })
})

describe("Offline operation", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    setAbsentBinary()
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    restoreEnv(origEnv)
  })

  it("core FDX VCI workflow does not require network", async () => {
    const snap = await queryFdxCapabilities(WS)
    // capabilities.rs explicitly states: no network access, no telemetry
    expect(snap.networkAccess).toBe(false)
    expect(snap.telemetry).toBe(false)
  })
})
