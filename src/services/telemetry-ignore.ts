import { existsSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Ensure FlowDeck state & telemetry directories (.flowdeck, .codebase, .fd-plan)
 * are excluded in the workspace root .gitignore so runtime telemetry does not
 * pollute the user's git status.
 */
export function ensureFlowDeckGitIgnored(directory: string): boolean {
  const gitignorePath = join(directory, ".gitignore")
  if (!existsSync(gitignorePath)) return false

  try {
    const content = readFileSync(gitignorePath, "utf-8")
    const entriesToIgnore = [".flowdeck/", ".codebase/", ".fd-plan/"]
    const missing = entriesToIgnore.filter((entry) => !content.includes(entry) && !content.includes(entry.slice(0, -1)))

    if (missing.length === 0) return false

    const appendText = `\n# FlowDeck state & telemetry\n${missing.join("\n")}\n`
    appendFileSync(gitignorePath, appendText, "utf-8")
    return true
  } catch {
    return false
  }
}
