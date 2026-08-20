/**
 * FlowDeck Command Loader
 *
 * Scans the commands directory for markdown templates with optional YAML frontmatter.
 */

import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, join } from "path"

export interface LoadedCommand {
  description?: string
  template: string
}

export function loadCommands(commandsDir: string): Record<string, LoadedCommand> {
  if (!existsSync(commandsDir)) return {}
  const out: Record<string, LoadedCommand> = {}
  try {
    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith(".md")) continue
      const raw = readFileSync(join(commandsDir, file), "utf-8")
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      const template = fm ? fm[2].trim() : raw
      const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
      out[basename(file, ".md")] = desc ? { description: desc, template } : { template }
    }
  } catch {
    /* ignore read errors */
  }
  return out
}
