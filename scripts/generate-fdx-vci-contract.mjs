import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const root = process.env.FDX_VCI_CONTRACT_ROOT
  ? resolve(process.env.FDX_VCI_CONTRACT_ROOT)
  : resolve(import.meta.dirname, "..")
const outputPath = resolve(root, "src/generated/fdx-vci-contract.ts")

function read(path) {
  return readFileSync(resolve(root, path), "utf8")
}

function constant(source, name) {
  const match = source.match(new RegExp(`pub const ${name}: u32 = (\\d+);`))
  if (!match) throw new Error(`Missing authoritative Rust constant ${name}`)
  return Number(match[1])
}

const protocol = read("crates/fdx/src/protocol.rs")
const capabilities = read("crates/fdx/src/intelligence/capabilities.rs")
const calibration = read("crates/fdx/src/intelligence/calibration/model.rs")
const policy = read("crates/fdx/src/intelligence/policy/model.rs")

const predicates = protocol.match(/FDX_SUPPORTED_ATTESTATION_PREDICATE_VERSIONS: &\[u32\] = &\[([^\]]+)\]/)
if (!predicates) throw new Error("Missing authoritative Rust predicate-version list")
const predicateVersions = predicates[1].split(",").map(value => Number(value.trim()))
if (predicateVersions.some(value => !Number.isInteger(value))) {
  throw new Error("Rust predicate-version list is malformed")
}

const contract = {
  protocolVersion: constant(protocol, "FDX_PROTOCOL_VERSION"),
  graphSchemaVersion: constant(protocol, "FDX_GRAPH_SCHEMA_VERSION"),
  graphSchemaMinimumReadable: constant(capabilities, "MINIMUM_READABLE_GRAPH_SCHEMA_VERSION"),
  capabilityContractVersion: constant(protocol, "FDX_CAPABILITY_CONTRACT_VERSION"),
  calibrationContractVersion: constant(calibration, "CALIBRATION_CONTRACT_VERSION"),
  policyContractVersion: constant(policy, "POLICY_CONTRACT_VERSION"),
  selectionPolicyVersion: constant(protocol, "FDX_SELECTION_POLICY_VERSION"),
  predicateVersions: predicateVersions.map(version => `v${version}`),
  networkAccess: false,
  telemetry: false,
}

const rendered = `// Auto-generated from frozen Rust FDX contract constants. DO NOT EDIT.\n// Regenerate: node scripts/generate-fdx-vci-contract.mjs\n\nexport const FDX_NATIVE_CONTRACT = ${JSON.stringify(contract, null, 2)} as const\n`

if (process.argv.includes("--check")) {
  const existing = readFileSync(outputPath, "utf8")
  if (existing !== rendered) {
    throw new Error("FDX VCI contract artifact is stale; run node scripts/generate-fdx-vci-contract.mjs")
  }
  console.log("FDX VCI contract artifact matches frozen Rust constants")
} else {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, rendered)
  console.log(`Generated ${outputPath}`)
}
