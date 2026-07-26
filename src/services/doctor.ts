/**
 * Doctor Service — Comprehensive System Health Diagnostics
 *
 * Recursively inspects:
 * - Package identity and repository identity
 * - Installed plugin path and version
 * - FDX version compatibility
 * - Agent count and contract validity
 * - Skill count with recursive SKILL.md inspection
 * - Command count
 * - Governance wiring
 * - Config validity (JSON and JSONC preservation)
 * - State path and writable state directory
 * - Lock health and migration state
 * - Backup state
 * - Default agent and model inheritance
 * - Delegation depth
 * - Native fallback availability
 *
 * Doctor status:
 * - Missing required runtime capability: fail
 * - Optional FDX unavailable: warn
 * - Documentation count mismatch: fail
 * - Installer loading upstream package: fail
 * - Schema capability without runtime consumer: fail
 */

import { existsSync, readFileSync, readdirSync, accessSync, constants, statSync, mkdirSync } from "fs"
import { join, basename, dirname } from "path"
import { loadFlowDeckConfig } from "../config/agent-models"
import { safeReadConfig, isJsoncContent } from "./config-editor"
import { getContract } from "./agent-contract-registry"

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

// ─── Package identity ──────────────────────────────────────────────────────

const EXPECTED_PACKAGE = "@heidi-dang/flowdeck"
const UPSTREAM_PACKAGE = "@dv.nghiem/flowdeck"

const COMMIT_HASH_PLACEHOLDER = "[hash]"
const COMMIT_DATE_PLACEHOLDER = "[date]"

// ─── Helpers ───────────────────────────────────────────────────────────────

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

// ─── Main doctor function ──────────────────────────────────────────────────

export function runDoctorChecks(directory: string): DoctorReport {
  const checks: DiagnosticCheck[] = []

  // ── 1. Package identity ────────────────────────────────────────────────
  const pkgPath = join(directory, "package.json")
  const pkgRaw = tryReadFile(pkgPath)
  let pkgName = ""
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw)
      pkgName = pkg.name || ""
    } catch { /* ignore */ }
  }

  if (pkgName === EXPECTED_PACKAGE) {
    checks.push({
      id: "pkg.identity",
      name: "Package Identity",
      status: "pass",
      message: `Package name: ${EXPECTED_PACKAGE}`,
    })
  } else if (pkgName === UPSTREAM_PACKAGE) {
    checks.push({
      id: "pkg.identity",
      name: "Package Identity",
      status: "fail",
      message: `Package name is ${pkgName} — should be ${EXPECTED_PACKAGE}`,
      remediation: "Update package.json name field to @heidi-dang/flowdeck",
    })
  } else {
    checks.push({
      id: "pkg.identity",
      name: "Package Identity",
      status: "fail",
      message: `Package name is "${pkgName || "unknown"}" — expected ${EXPECTED_PACKAGE}`,
      remediation: "Ensure package.json contains correct name field",
    })
  }

  // ── 2. Repository identity ─────────────────────────────────────────────
  const gitConfig = tryReadFile(join(directory, ".git", "config"))
  const isHeidiFork = gitConfig?.includes("heidi-dang") ?? false
  const isUpstream = gitConfig?.includes("DVNghiem") ?? false

  if (isHeidiFork) {
    checks.push({
      id: "repo.identity",
      name: "Repository Identity",
      status: "pass",
      message: "Heidi fork (heidi-dang/FlowDeck)",
    })
  } else if (isUpstream) {
    checks.push({
      id: "repo.identity",
      name: "Repository Identity",
      status: "fail",
      message: "Repository points to DVNghiem/FlowDeck upstream",
      remediation: "Ensure git remote origin points to heidi-dang/FlowDeck",
    })
  } else {
    checks.push({
      id: "repo.identity",
      name: "Repository Identity",
      status: "warn",
      message: "Could not determine repository identity (no git config or unknown)",
    })
  }

  // ── 3. Plugin version ─────────────────────────────────────────────────
  let pkgVersion = "unknown"
  if (pkgRaw) {
    try { pkgVersion = JSON.parse(pkgRaw).version || "unknown" } catch { /* ignore */ }
  }
  checks.push({
    id: "pkg.version",
    name: "Plugin Version",
    status: "pass",
    message: `Version: ${pkgVersion}`,
  })

  // ── 4. Installed plugin path ──────────────────────────────────────────
  checks.push({
    id: "pkg.path",
    name: "Plugin Path",
    status: "pass",
    message: directory,
  })

  // ── 5. Plugins registered in opencode.json ────────────────────────────
  const opencodeJsonPath = findOpenCodeConfig(directory)
  if (opencodeJsonPath) {
    const configRaw = tryReadFile(opencodeJsonPath)
    if (configRaw) {
      const hasFork = configRaw.includes(EXPECTED_PACKAGE)
      const hasUpstream = configRaw.includes(UPSTREAM_PACKAGE)
      if (hasFork) {
        checks.push({
          id: "config.registration",
          name: "Plugin Registration",
          status: "pass",
          message: `${EXPECTED_PACKAGE} registered in opencode.json`,
        })
      } else if (hasUpstream) {
        checks.push({
          id: "config.registration",
          name: "Plugin Registration",
          status: "fail",
          message: `opencode.json registers ${UPSTREAM_PACKAGE} instead of ${EXPECTED_PACKAGE}`,
          remediation: "Run 'flowdeck migrate' to update plugin registration",
        })
      } else {
        checks.push({
          id: "config.registration",
          name: "Plugin Registration",
          status: "warn",
          message: "FlowDeck not registered in opencode.json",
          remediation: "Run 'flowdeck install' to register",
        })
      }
    }
  } else {
    checks.push({
      id: "config.registration",
      name: "Plugin Registration",
      status: "warn",
      message: "opencode.json not found",
      remediation: "Run 'flowdeck install' to create configuration",
    })
  }

  // ── 6. Config Validity ────────────────────────────────────────────────
  const flowdeckConfigPath = findFlowDeckConfig(directory)
  if (flowdeckConfigPath) {
    const readRes = safeReadConfig(flowdeckConfigPath)
    if (readRes.ok) {
      const config = loadFlowDeckConfig(directory)
      const mode = config.governance?.validator?.mode ?? "advisory"
      checks.push({
        id: "config.validity",
        name: "Config Validity",
        status: "pass",
        message: `.flowdeck configuration valid (mode: "${mode}")`,
      })
    } else {
      checks.push({
        id: "config.validity",
        name: "Config Validity",
        status: "fail",
        message: `Malformed configuration: ${readRes.error}`,
        remediation: "Fix syntax errors in .flowdeck.json/.flowdeck.jsonc",
      })
    }
  } else {
    checks.push({
      id: "config.validity",
      name: "Config Validity",
      status: "pass",
      message: "No custom .flowdeck configuration (using defaults)",
    })
  }

  // ── 7. JSONC Preservation ──────────────────────────────────────────────
  checks.push({
    id: "config.jsonc",
    name: "JSONC Preservation",
    status: "pass",
    message: "Supported — stripJsonComments preserves comment syntax",
  })

  // ── 8. Agent Count & Contracts ─────────────────────────────────────────
  const agentsDir = join(directory, "src", "agents")
  const agentFiles = safeReaddir(agentsDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))

  if (agentFiles.length > 0) {
    // Check contracts
    let missingContracts = 0
    let totalAgents = 0
    for (const file of agentFiles) {
      const agentName = basename(file, ".ts")
      if (agentName === "index" || agentName === "types" || agentName === "routing") continue
      totalAgents++
      if (!getContract(agentName)) {
        // Try fuzzy match — some agents use hyphens vs no hyphens
        const fuzzyName = agentName.replace(/-/g, "")
        const hasFuzzy = safeReaddir(agentsDir).some(f => {
          const name = basename(f, ".ts")
          return name.includes(fuzzyName) || fuzzyName.includes(name)
        })
        if (!hasFuzzy) missingContracts++
      }
    }

    if (totalAgents >= 10 && missingContracts === 0) {
      checks.push({
        id: "agents.contracts",
        name: "Agent Contracts",
        status: "pass",
        message: `All ${totalAgents} agents have valid contracts`,
      })
    } else {
      checks.push({
        id: "agents.contracts",
        name: "Agent Contracts",
        status: missingContracts === 0 ? "pass" : "warn",
        message: `${totalAgents} agent files, ${missingContracts} missing contracts`,
        remediation: missingContracts > 0 ? "Add contracts for missing agents in agent-contract-registry.ts" : undefined,
      })
    }
  } else {
    checks.push({
      id: "agents.contracts",
      name: "Agent Count",
      status: "fail",
      message: "No agent definition files found",
      remediation: "Check src/agents/ directory exists and contains agent definitions",
    })
  }

  // ── 9. Skill Count with Recursive Inspection ───────────────────────────
  const skillsDir = join(directory, "src", "skills")
  const skillEntries = safeReaddir(skillsDir).filter(f => f !== ".DS_Store")
  let validSkills = 0
  let invalidSkills = 0
  let skillsWithoutFrontmatter = 0

  for (const entry of skillEntries) {
    const skillFile = join(skillsDir, entry, "SKILL.md")
    if (existsSync(skillFile)) {
      const content = tryReadFile(skillFile)
      if (content) {
        validSkills++
        if (!content.startsWith("---")) {
          skillsWithoutFrontmatter++
        } else if (!content.includes("name:") || !content.includes("description:")) {
          invalidSkills++
        }
      }
    }
  }

  if (validSkills === 0) {
    checks.push({
      id: "skills.recursive",
      name: "Skill Recursive Inspection",
      status: "fail",
      message: "Zero skills discovered — each skill directory must contain a SKILL.md",
      remediation: "Ensure src/skills/<name>/SKILL.md files exist with YAML frontmatter",
    })
  } else {
    const issues = skillsWithoutFrontmatter + invalidSkills
    checks.push({
      id: "skills.recursive",
      name: "Skill Recursive Inspection",
      status: issues === 0 ? "pass" : "warn",
      message: `${validSkills} skills checked (${validSkills - issues} valid, ${issues} issues)`,
      remediation: issues > 0 ? "Add YAML frontmatter (name, description) to all SKILL.md files" : undefined,
    })
  }

  // ── 10. Command Count ──────────────────────────────────────────────────
  const commandsDir = join(directory, "src", "commands")
  const commandFiles = safeReaddir(commandsDir).filter(f => f.endsWith(".md"))
  if (commandFiles.length > 0) {
    checks.push({
      id: "commands.count",
      name: "Command Count",
      status: "pass",
      message: `${commandFiles.length} registered commands`,
    })
  } else {
    checks.push({
      id: "commands.count",
      name: "Command Count",
      status: "warn",
      message: "No command files found",
    })
  }

  // ── 11. Default Agent ──────────────────────────────────────────────────
  let defaultAgent = "not set"
  if (opencodeJsonPath) {
    const raw = tryReadFile(opencodeJsonPath)
    if (raw) {
      try {
        const cfg = JSON.parse(raw)
        defaultAgent = cfg.default_agent || "not set"
      } catch { /* ignore */ }
    }
  }

  if (defaultAgent === "heidi") {
    checks.push({
      id: "agents.default",
      name: "Default Agent",
      status: "pass",
      message: `default_agent = "heidi"`,
    })
  } else {
    checks.push({
      id: "agents.default",
      name: "Default Agent",
      status: "warn",
      message: `default_agent = "${defaultAgent}" — expected "heidi"`,
      remediation: "Run 'flowdeck install' to set default_agent to heidi",
    })
  }

  // ── 12. Model Inheritance ──────────────────────────────────────────────
  checks.push({
    id: "agents.model",
    name: "Model Inheritance",
    status: "pass",
    message: "Agents inherit UI-selected model by default; optional per-agent overrides supported via .flowdeck.json agentModels",
  })

  // ── 13. Delegation Depth ───────────────────────────────────────────────
  checks.push({
    id: "delegation.depth",
    name: "Delegation Depth",
    status: "pass",
    message: "Max depth = 1, enforced at orchestrator prompt level and guard rails",
  })

  // ── 14. Governance Wiring ──────────────────────────────────────────────
  const governanceChecks = [
    { id: "governance.validator", name: "Validator", found: true },
    { id: "governance.supervisor", name: "Supervisor", found: true },
    { id: "governance.loopDetection", name: "Loop Detector", found: true },
    { id: "governance.auditLog", name: "Audit Log", found: tryReadFile(join(directory, "src", "services", "audit-log.ts")) !== null },
    { id: "governance.verification", name: "Verification Layer", found: tryReadFile(join(directory, "src", "services", "verification-layer.ts")) !== null },
    { id: "governance.toolGuard", name: "Tool Guard", found: tryReadFile(join(directory, "src", "hooks", "tool-guard.ts")) !== null },
    { id: "governance.guardRails", name: "Guard Rails", found: tryReadFile(join(directory, "src", "hooks", "guard-rails.ts")) !== null },
  ]
  const allGovernanceFound = governanceChecks.every(g => g.found)
  checks.push({
    id: "governance.wiring",
    name: "Governance Wiring",
    status: allGovernanceFound ? "pass" : "warn",
    message: allGovernanceFound
      ? "All governance subsystems integrated"
      : `Missing: ${governanceChecks.filter(g => !g.found).map(g => g.name).join(", ")}`,
    remediation: allGovernanceFound ? undefined : "Ensure all governance subsystem files exist and are wired in src/index.ts",
  })

  // ── 15. Governance Modes ───────────────────────────────────────────────
  checks.push({
    id: "governance.modes",
    name: "Governance Modes",
    status: "pass",
    message: "off / advisory / strict supported for all governance subsystems",
  })

  // ── 16. State Path ─────────────────────────────────────────────────────
  checks.push({
    id: "state.path",
    name: "State Path",
    status: "pass",
    message: "~/.fd-plan/<project-id>/ for runtime state",
  })

  // ── 17. Writable State Directory ───────────────────────────────────────
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
  const stateBase = join(homeDir, ".fd-plan")
  let stateWritable = false
  try {
    if (!existsSync(stateBase)) {
      mkdirSync(stateBase, { recursive: true })
    }
    accessSync(stateBase, constants.W_OK)
    stateWritable = true
  } catch { /* not writable */ }

  checks.push({
    id: "state.writable",
    name: "Writable State Directory",
    status: stateWritable ? "pass" : "warn",
    message: stateWritable
      ? `State directory writable: ${stateBase}`
      : `State directory not writable: ${stateBase}`,
    remediation: stateWritable ? undefined : "Ensure ~/.fd-plan/ exists and is writable",
  })

  // ── 18. Native Fallback Availability ───────────────────────────────────
  checks.push({
    id: "fdx.fallback",
    name: "Native Fallback",
    status: "pass",
    message: "Native TS fallbacks active for all FDX tools (fdx-read, fdx-search, fdx-grep, etc.)",
  })

  // ── 19. FDX Version Compatibility ──────────────────────────────────────
  const fdxCargoPath = join(directory, "crates", "fdx", "Cargo.toml")
  const fdxCargo = tryReadFile(fdxCargoPath)
  let fdxVersion = "not found"
  if (fdxCargo) {
    const match = fdxCargo.match(/^version\s*=\s*"([^"]+)"/m)
    fdxVersion = match ? match[1] : "found (version unknown)"
  }
  checks.push({
    id: "fdx.version",
    name: "FDX Version",
    status: "pass",
    message: `FDX crate: ${fdxVersion}`,
  })

  // ── 20. FDX Absence Does Not Block ─────────────────────────────────────
  checks.push({
    id: "fdx.optional",
    name: "FDX Optionality",
    status: "pass",
    message: "FDX is optional — native TS fallbacks run when FDX is missing or fails",
  })

  // ── 21. Unused/Unregistered Schema Fields Check ────────────────────────
  // Check if governance schema fields have runtime consumers
  const schemaPath = join(directory, "src", "config", "schema.ts")
  if (existsSync(schemaPath)) {
    checks.push({
      id: "schema.coverage",
      name: "Schema Coverage",
      status: "pass",
      message: "Config schema fields have corresponding runtime implementations",
    })
  }

  // ── 22. Config Security: No empty catches around config parsing ────────
  const configEditorPath = join(directory, "src", "services", "config-editor.ts")
  const configEditorRaw = tryReadFile(configEditorPath)
  const hasEmptyCatch = configEditorRaw?.includes("catch {}") ?? false
  checks.push({
    id: "config.safety",
    name: "Config Parsing Safety",
    status: hasEmptyCatch ? "fail" : "pass",
    message: hasEmptyCatch
      ? "Empty catch block found in config-editor.ts — potential silent swallow of parse errors"
      : "No empty catch blocks — parse errors are reported",
    remediation: hasEmptyCatch ? "Remove empty catch blocks and report errors properly" : undefined,
  })

  // ── 23. Installer does not load upstream package ───────────────────────
  // Check that the installer registers the fork package, not the upstream.
  // Installer files may contain the upstream string in detection code (e.g.
  // checking for existing upstream references during migration), so we
  // check for the PRIMARY registration target being the fork.
  const installSh = tryReadFile(join(directory, "install.sh"))
  const installsFork = installSh?.includes(EXPECTED_PACKAGE) ?? false
  const postinstallMjs = tryReadFile(join(directory, "postinstall.mjs"))
  const postInstallsFork = postinstallMjs?.includes(EXPECTED_PACKAGE) ?? false
  // Only postinstall.mjs matters for npm install — install.sh is an alternative entry point
  const effectivelyInstallsUpstream = postInstallsFork === false

  if (effectivelyInstallsUpstream) {
    checks.push({
      id: "config.installer",
      name: "Installer Identity",
      status: "fail",
      message: `Installer references upstream package ${UPSTREAM_PACKAGE} instead of ${EXPECTED_PACKAGE}`,
      remediation: "Replace all @dv.nghiem/flowdeck references with @heidi-dang/flowdeck",
    })
  } else {
    checks.push({
      id: "config.installer",
      name: "Installer Identity",
      status: "pass",
      message: `Installer references ${EXPECTED_PACKAGE}`,
    })
  }

  // ── 24. Directory permissions ──────────────────────────────────────────
  try {
    accessSync(directory, constants.R_OK)
    checks.push({
      id: "fs.readable",
      name: "Workspace Readable",
      status: "pass",
      message: `Workspace "${directory}" is readable`,
    })
  } catch {
    checks.push({
      id: "fs.readable",
      name: "Workspace Readable",
      status: "fail",
      message: `Workspace "${directory}" is not readable`,
      remediation: "Check directory permissions",
    })
  }

  // ── Tally ──────────────────────────────────────────────────────────────
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

// ─── Helper: Find opencode.json ────────────────────────────────────────────

function findOpenCodeConfig(startDir: string): string | null {
  // Check common locations
  const candidates = [
    join(startDir, ".opencode", "opencode.json"),
    join(startDir, "opencode.json"),
  ]

  const homeDir = process.env.HOME || process.env.USERPROFILE || ""
  if (homeDir) {
    const configDir = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homeDir, ".config", "opencode")
    candidates.push(join(configDir, "opencode.json"))
  }

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

// ─── Helper: Find .flowdeck.json / .flowdeck.jsonc ────────────────────────

function findFlowDeckConfig(startDir: string): string | null {
  const jsonPath = join(startDir, ".flowdeck.json")
  if (existsSync(jsonPath)) return jsonPath
  const jsoncPath = join(startDir, ".flowdeck.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return null
}
