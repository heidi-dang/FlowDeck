/**
 * ConfigCache — Zero-disk-read FlowDeck configuration cache.
 *
 * Caches parsed FlowDeck config, governance mode, supervisor config,
 * agent model mappings, and autonomy settings. Invalidates on mtime change.
 */

import { existsSync, statSync, readFileSync } from "fs"
import { join } from "path"
import type { FlowDeckConfig } from "../config/schema"
import { DEFAULT_CONFIG, stripJsonComments } from "../config/agent-models"

interface CachedConfig {
  config: FlowDeckConfig
  mtime: number
  resolvedPath: string
}

const _cache = new Map<string, CachedConfig>()

function resolveConfigPath(root: string): string | null {
  const candidates = [
    join(root, ".opencode", "flowdeck.jsonc"),
    join(root, ".opencode", "flowdeck.json"),
    join(root, ".flowdeck.json"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function parseConfig(path: string): FlowDeckConfig {
  try {
    const raw = readFileSync(path, "utf-8")
    const stripped = stripJsonComments(raw)
    const parsed = JSON.parse(stripped) as FlowDeckConfig
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Get FlowDeck config for a project root, using in-memory cache.
 * Falls back to DEFAULT_CONFIG if no config file exists.
 */
export function getCachedConfig(root: string): FlowDeckConfig {
  const cached = _cache.get(root)
  const configPath = resolveConfigPath(root)

  if (!configPath) {
    // Cache the no-config case with a sentinel so repeated calls return the same object
    if (cached && cached.resolvedPath === "" && cached.mtime === -1) {
      return cached.config
    }
    const defaultCfg: FlowDeckConfig = { ...DEFAULT_CONFIG }
    _cache.set(root, { config: defaultCfg, mtime: -1, resolvedPath: "" })
    return defaultCfg
  }

  try {
    const mtime = statSync(configPath).mtimeMs
    if (cached && cached.mtime === mtime && cached.resolvedPath === configPath) {
      return cached.config
    }
    const config = parseConfig(configPath)
    _cache.set(root, { config, mtime, resolvedPath: configPath })
    return config
  } catch {
    return cached?.config ?? { ...DEFAULT_CONFIG }
  }
}

/** Invalidate config cache for a root. */
export function invalidateConfigCache(root: string): void {
  _cache.delete(root)
}

/** For tests only. */
export function _resetConfigCache(): void {
  _cache.clear()
}
