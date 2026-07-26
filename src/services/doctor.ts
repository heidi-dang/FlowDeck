/**
 * Doctor Service
 *
 * System health diagnostics engine inspecting runtime environment,
 * configuration validity, capability contracts, skills frontmatter,
 * FDX availability, and directory permissions.
 */

import { existsSync, readFileSync, readdirSync, accessSync, constants } from "fs"
import { join } from "path"
import { loadFlowDeckConfig } from "../config/agent-models"
import { AGENT_NAMES } from "../agents"
import { getContract } from "./agent-contract-registry"
import { getFdxAvailabilityStatus } from "../tools/fdx"
import { safeReadConfig } from "./config-editor"

export interface DiagnosticCheck {
  id: string
  name: string
  status: "pass" | "warn" | "fail"
  message: string
  remediation?: string
}

export interface DoctorReport {
  timestamp: string
  directory: string
  passed: number
  warned: number
  failed: number
  checks: DiagnosticCheck[]
}

export function runDoctorChecks(directory: string): DoctorReport {
  const checks: DiagnosticCheck[] = []

  // Check 1: Node.js runtime environment
  const nodeVer = process.version
  checks.push({
    id: "env.node",
    name: "Node.js Environment",
    status: "pass",
    message: `Node.js active version ${nodeVer}`,
  })

  // Check 2: Writable workspace directory
  try {
    accessSync(directory, constants.W_OK)
    checks.push({
      id: "fs.writable",
      name: "Workspace Directory Writable",
      status: "pass",
      message: `Workspace directory "${directory}" is writable.`,
    })
  } catch {
    checks.push({
      id: "fs.writable",
      name: "Workspace Directory Writable",
      status: "fail",
      message: `Workspace directory "${directory}" is not writable.`,
      remediation: "Ensure directory permissions grant write access.",
    })
  }

  // Check 3: FlowDeck Configuration (.flowdeck.json / .flowdeck.jsonc)
  const jsonPath = join(directory, ".flowdeck.json")
  const jsoncPath = join(directory, ".flowdeck.jsonc")
  const targetConfig = existsSync(jsonPath) ? jsonPath : existsSync(jsoncPath) ? jsoncPath : null

  if (targetConfig) {
    const readRes = safeReadConfig(targetConfig)
    if (!readRes.ok) {
      checks.push({
        id: "config.flowdeck",
        name: "FlowDeck Configuration",
        status: "fail",
        message: `Syntax error in ${targetConfig}: ${readRes.error}`,
        remediation: `Verify syntax of ${targetConfig} or restore from backup file.`,
      })
    } else {
      const config = loadFlowDeckConfig(directory)
      const mode = config.governance?.validator?.mode ?? "advisory"
      checks.push({
        id: "config.flowdeck",
        name: "FlowDeck Configuration",
        status: "pass",
        message: `FlowDeck configuration loaded successfully (validator mode: "${mode}").`,
      })
    }
  } else {
    checks.push({
      id: "config.flowdeck",
      name: "FlowDeck Configuration",
      status: "pass",
      message: "No custom .flowdeck.json configuration file present (using defaults).",
    })
  }

  // Check 4: Agent Capability Contracts
  let missingContracts = 0
  for (const name of AGENT_NAMES) {
    if (!getContract(name)) missingContracts++
  }
  if (missingContracts === 0) {
    checks.push({
      id: "agents.contracts",
      name: "Agent Capability Contracts",
      status: "pass",
      message: `All ${AGENT_NAMES.length} registered agents have valid capability contracts.`,
    })
  } else {
    checks.push({
      id: "agents.contracts",
      name: "Agent Capability Contracts",
      status: "fail",
      message: `${missingContracts} agents are missing registered capability contracts.`,
      remediation: "Audit src/services/agent-contract-registry.ts for missing agent contracts.",
    })
  }

  // Check 5: Skill Definitions YAML Frontmatter Header Check
  try {
    const skillsDir = join(directory, "src", "skills")
    if (existsSync(skillsDir)) {
      const files = readdirSync(skillsDir).filter(f => f.endsWith(".md"))
      let invalidCount = 0
      for (const file of files) {
        const content = readFileSync(join(skillsDir, file), "utf-8")
        if (!content.startsWith("---") || !content.includes("name:") || !content.includes("description:")) {
          invalidCount++
        }
      }
      if (invalidCount === 0) {
        checks.push({
          id: "skills.frontmatter",
          name: "Skill Frontmatter Headers",
          status: "pass",
          message: `All ${files.length} skill definition files have valid YAML frontmatter headers.`,
        })
      } else {
        checks.push({
          id: "skills.frontmatter",
          name: "Skill Frontmatter Headers",
          status: "warn",
          message: `${invalidCount} out of ${files.length} skill definitions missing required YAML frontmatter.`,
          remediation: "Add YAML frontmatter (name, description) to all skill markdown files in src/skills/.",
        })
      }
    } else {
      checks.push({
        id: "skills.frontmatter",
        name: "Skill Frontmatter Headers",
        status: "pass",
        message: "No local src/skills directory present.",
      })
    }
  } catch (err: any) {
    checks.push({
      id: "skills.frontmatter",
      name: "Skill Frontmatter Headers",
      status: "warn",
      message: `Could not check skills directory: ${err.message}`,
    })
  }

  // Check 6: FDX Subsystem & Fallback Status
  const fdxStatus = getFdxAvailabilityStatus()
  checks.push({
    id: "fdx.status",
    name: "FDX Subsystem & Fallback Status",
    status: fdxStatus.available ? "pass" : "warn",
    message: fdxStatus.message,
    remediation: fdxStatus.available
      ? undefined
      : "Install Rust & compile FDX (`cargo install --path crates/fdx`) for maximum performance, or rely on active native TS fallbacks.",
  })

  const passed = checks.filter(c => c.status === "pass").length
  const warned = checks.filter(c => c.status === "warn").length
  const failed = checks.filter(c => c.status === "fail").length

  return {
    timestamp: new Date().toISOString(),
    directory,
    passed,
    warned,
    failed,
    checks,
  }
}
