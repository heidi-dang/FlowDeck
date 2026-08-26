import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const generator = resolve(process.cwd(), "scripts/generate-fdx-vci-contract.mjs")
let fixtureRoot = ""

function writeFixture(relativePath: string, contents: string) {
  const target = join(fixtureRoot, relativePath)
  mkdirSync(resolve(target, ".."), { recursive: true })
  writeFileSync(target, contents)
}

function runGenerator(check = false) {
  return execFileSync(process.execPath, [generator, ...(check ? ["--check"] : [])], {
    env: { ...process.env, FDX_VCI_CONTRACT_ROOT: fixtureRoot },
    encoding: "utf8",
    stdio: "pipe",
  })
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ""
})

describe("FDX native contract generator", () => {
  it("accepts a fresh artifact and fails closed when the generated contract is stale", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fdx-contract-generator-"))
    writeFixture("crates/fdx/src/protocol.rs", `
      pub const FDX_PROTOCOL_VERSION: u32 = 2;
      pub const FDX_GRAPH_SCHEMA_VERSION: u32 = 10;
      pub const FDX_CAPABILITY_CONTRACT_VERSION: u32 = 1;
      pub const FDX_SELECTION_POLICY_VERSION: u32 = 1;
      pub const FDX_SUPPORTED_ATTESTATION_PREDICATE_VERSIONS: &[u32] = &[1, 2];
    `)
    writeFixture("crates/fdx/src/intelligence/capabilities.rs", "pub const MINIMUM_READABLE_GRAPH_SCHEMA_VERSION: u32 = 1;\n")
    writeFixture("crates/fdx/src/intelligence/calibration/model.rs", "pub const CALIBRATION_CONTRACT_VERSION: u32 = 2;\n")
    writeFixture("crates/fdx/src/intelligence/policy/model.rs", "pub const POLICY_CONTRACT_VERSION: u32 = 1;\n")

    runGenerator()
    expect(runGenerator(true)).toContain("matches frozen Rust constants")

    writeFileSync(join(fixtureRoot, "src/generated/fdx-vci-contract.ts"), "stale artifact\n")
    expect(() => runGenerator(true)).toThrow(/artifact is stale/)
  })
})
