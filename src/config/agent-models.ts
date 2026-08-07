import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { FlowDeckConfig } from "./schema"

export type { FlowDeckConfig } from "./schema"

export interface AgentModelConfig {
  model?: string
  temperature?: number
  maxTokens?: number
}

export const DEFAULT_CONFIG: FlowDeckConfig = {
  agentModels: {},
  // NOTE: betterHarness is intentionally absent from the production default.
  // The Better Harness runtime is a standalone development/QA facility and
  // must never be activated by the production plugin. Any configuration that
  // sets betterHarness.enabled=true is rejected by loadFlowDeckConfig with a
  // migration error (see validateBetterHarnessProductionConfig).
  maxDelegationDepth: 1,
  maxWritesPerAgent: 15,
}

/**
 * Fail-closed validation for the deprecated `betterHarness` configuration
 * block in the PRODUCTION plugin configuration.
 *
 * The production plugin must not accept `betterHarness.enabled=true` as
 * permission to start a second orchestration runtime. Two behaviors are
 * supported:
 *
 * 1. `betterHarness.enabled === true` -> throws a migration error so the
 *    production plugin refuses to start (fail closed). Users must use the
 *    standalone command instead.
 * 2. `betterHarness` present with `enabled !== true` (or absent) -> emits a
 *    deprecation diagnostic and is treated as inert. The returned config
 *    forces `enabled: false` so no runtime can ever be activated.
 *
 * @param config the sanitized production config (may carry betterHarness)
 * @param sourcePath config file path for diagnostics (optional)
 * @returns a config that can never activate the Better Harness runtime
 */
export function validateBetterHarnessProductionConfig(
  config: FlowDeckConfig,
  sourcePath?: string,
): FlowDeckConfig {
  const bh = config.betterHarness
  const source = sourcePath ? ` (${sourcePath})` : ""
  if (bh?.enabled === true) {
    throw new Error(
      "[flowdeck] betterHarness.enabled=true is REJECTED in the production plugin configuration" +
        source +
        ".\n" +
        "Better Harness is a standalone development/QA facility. It is no longer " +
        "activated by the FlowDeck production plugin, which must have exactly one " +
        "writable orchestration authority (the canonical schema-v0.2.6 runtime).\n" +
        "Replacement: run the standalone harness explicitly with:\n" +
        "  npx @heidi-dang/flowdeck flowdeck-better-harness --project <project-path> [--state-dir <dir>]\n" +
        "or locally:  bun run src/better-harness/standalone.ts --project <project-path>\n" +
        "Migration: remove the betterHarness block (or set enabled=false) from your " +
        "flowdeck configuration. The field is deprecated and will be removed in a " +
        "future version. Harness runs are independent of canonical task runs and are " +
        "never recovered, exposed, or completed by the production plugin.",
    )
  }
  if (bh !== undefined) {
    // Deprecated but inert: emit diagnostics, force disabled, keep other
    // fields available for the standalone tooling (read-only usage).
    // eslint-disable-next-line no-console
    console.warn(
      "[flowdeck] DEPRECATED: the betterHarness configuration block is deprecated and inert in the " +
        "production plugin" +
        source +
        ". Use the standalone command `flowdeck-better-harness` for Better Harness development/QA.",
    )
    return {
      ...config,
      betterHarness: {
        ...bh,
        enabled: false,
      },
    }
  }
  return config
}

function getGlobalConfigDir(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))
  )
}

/**
 * Strip JSONC comments without corrupting string literals.
 * Handles single-line // comments and multi-line /* ... * / comments.
 */
export function stripJsonComments(content: string): string {
  let result = ""
  let inString = false
  let escape = false
  let i = 0

  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1]

    if (inString) {
      result += ch
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }

    if (ch === "/" && next === "/") {
      // Skip until end of line
      while (i < content.length && content[i] !== "\n") i++
      continue
    }

    if (ch === "/" && next === "*") {
      // Skip until */
      i += 2
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++
      i += 2
      continue
    }

    result += ch
    i++
  }

  return result
}

const VALID_CONFIG_KEYS: (keyof FlowDeckConfig)[] = [
  "agentModels",
  "agents",
  "maxDelegationDepth",
  "supervisor",
  "betterHarness",
  "designFirst",
  "governance",
  "maxWritesPerAgent"
]

function sanitizeConfig(parsed: unknown): FlowDeckConfig {
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_CONFIG }
  }
  const raw = parsed as Record<string, unknown>
  const sanitized: FlowDeckConfig = { ...DEFAULT_CONFIG }
  for (const key of VALID_CONFIG_KEYS) {
    if (key in raw) {
      ;(sanitized as Record<string, unknown>)[key] = raw[key]
    }
  }
  return sanitized
}

/**
 * Load FlowDeck configuration from the first available location.
 *
 * Search order (first valid wins):
 *   1. <directory>/.flowdeck.jsonc
 *   2. <directory>/.flowdeck.json
 *   3. <directory>/.opencode/flowdeck.jsonc
 *   4. <directory>/.opencode/flowdeck.json
 *   5. global ~/.config/opencode/flowdeck.json
 *
 * Malformed files are silently skipped to preserve no-stdout behavior.
 */
export function loadFlowDeckConfig(directory?: string): FlowDeckConfig {
  const candidates: string[] = []

  if (directory) {
    candidates.push(join(directory, ".flowdeck.jsonc"))
    candidates.push(join(directory, ".flowdeck.json"))
    candidates.push(join(directory, ".opencode", "flowdeck.jsonc"))
    candidates.push(join(directory, ".opencode", "flowdeck.json"))
  }
  candidates.push(join(getGlobalConfigDir(), "flowdeck.json"))

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue
    try {
      const raw = readFileSync(configPath, "utf-8")
      const stripped = configPath.endsWith(".jsonc") ? stripJsonComments(raw) : raw
      const config = sanitizeConfig(JSON.parse(stripped))
      // Fail closed: a production configuration must never be allowed to
      // activate the Better Harness runtime (see P0-2).
      return validateBetterHarnessProductionConfig(config, configPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A Better Harness migration rejection must surface as a hard error —
      // it is not a malformed-config skip condition.
      if (err instanceof Error && msg.includes("betterHarness.enabled=true is REJECTED")) {
        throw err
      }
      console.warn(`[flowdeck] Malformed config at ${configPath}: ${msg}. Trying next candidate.`)
    }
  }

  return validateBetterHarnessProductionConfig({ ...DEFAULT_CONFIG })
}

/**
 * Resolve per-agent model strings from the configuration.
 * agentModels takes precedence over the legacy agents key.
 */
export function resolveAgentModels(config: FlowDeckConfig): Record<string, string> {
  const result: Record<string, string> = {}

  const addFrom = (source?: Record<string, AgentModelConfig>) => {
    if (!source) return
    for (const [name, cfg] of Object.entries(source)) {
      if (cfg.model && !(name in result)) {
        result[name] = cfg.model
      }
    }
  }

  addFrom(config.agentModels)
  addFrom(config.agents)

  return result
}

/**
 * Parse a "provider/model" model spec into the SDK model shape.
 * Returns undefined if the spec is empty or has no separator.
 */
export function parseModelSpec(modelSpec?: string): { providerID: string; modelID: string } | undefined {
  if (!modelSpec) return undefined
  const separatorIndex = modelSpec.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === modelSpec.length - 1) return undefined
  return {
    providerID: modelSpec.slice(0, separatorIndex),
    modelID: modelSpec.slice(separatorIndex + 1),
  }
}
