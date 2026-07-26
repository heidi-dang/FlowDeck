import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ConfigReadResult<T = Record<string, unknown>> {
  ok: boolean
  data?: T
  error?: string
  rawContent?: string
}

export interface ConfigUpdateResult<T = Record<string, unknown>> {
  ok: boolean
  data?: T
  backupPath?: string
  error?: string
}

/**
 * Strip single-line (//) and multi-line (/\* ... *\/) comments from JSONC text safely,
 * preserving strings that contain comment delimiters.
 */
export function stripJsonComments(jsoncText: string): string {
  let insideString: string | false = false
  let insideComment: "single" | "multi" | false = false
  let result = ""

  for (let i = 0; i < jsoncText.length; i++) {
    const char = jsoncText[i]
    const nextChar = jsoncText[i + 1]

    if (insideComment === "single") {
      if (char === "\n" || char === "\r") {
        insideComment = false
        result += char
      }
      continue
    }

    if (insideComment === "multi") {
      if (char === "*" && nextChar === "/") {
        insideComment = false
        i++
      }
      continue
    }

    if (insideString) {
      result += char
      if (char === "\\" && i + 1 < jsoncText.length) {
        result += jsoncText[++i]
      } else if (char === insideString) {
        insideString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      insideString = char
      result += char
      continue
    }

    if (char === "/" && nextChar === "/") {
      insideComment = "single"
      i++
      continue
    }

    if (char === "/" && nextChar === "*") {
      insideComment = "multi"
      i++
      continue
    }

    result += char
  }

  return result
}

/**
 * Safely parse JSON or JSONC content.
 * Returns exact error message if parsing fails.
 */
export function safeParseJson<T = Record<string, unknown>>(rawContent: string): ConfigReadResult<T> {
  const stripped = stripJsonComments(rawContent)
  try {
    const data = JSON.parse(stripped) as T
    return { ok: true, data, rawContent }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: errorMsg, rawContent }
  }
}

/**
 * Read a JSON/JSONC configuration file.
 * Does not throw on missing or malformed file.
 */
export function safeReadConfig<T = Record<string, unknown>>(filePath: string): ConfigReadResult<T> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` }
  }
  try {
    const rawContent = readFileSync(filePath, "utf-8")
    return safeParseJson<T>(rawContent)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Safely update a JSON/JSONC configuration file.
 *
 * Requirements:
 * 1. Never overwrite malformed configuration files.
 * 2. Create backup before valid mutation.
 * 3. Return exact parse failure on invalid JSON/JSONC.
 * 4. Atomic write using temporary file + rename.
 * 5. Preserve unrelated keys and properties.
 */
export function safeUpdateConfig<T = Record<string, unknown>>(
  filePath: string,
  updater: (current: T) => T
): ConfigUpdateResult<T> {
  let currentObj: T = {} as T
  let backupPath: string | undefined

  if (existsSync(filePath)) {
    const readRes = safeReadConfig<T>(filePath)
    if (!readRes.ok) {
      return {
        ok: false,
        error: `Cannot update malformed configuration at ${filePath}: ${readRes.error}`,
      }
    }
    currentObj = readRes.data!

    // Create backup before mutation
    backupPath = `${filePath}.bak`
    try {
      copyFileSync(filePath, backupPath)
    } catch {
      // Ignore backup error if unwritable
    }
  }

  // Apply mutations while preserving existing unrelated keys
  const updatedObj = updater({ ...currentObj })

  const dir = dirname(filePath)
  const tmpPath = join(dir, `.tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`)

  try {
    const formatted = JSON.stringify(updatedObj, null, 2) + "\n"
    writeFileSync(tmpPath, formatted, "utf-8")
    renameSync(tmpPath, filePath)
    return { ok: true, data: updatedObj, backupPath }
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    }
    return {
      ok: false,
      error: `Failed atomic write for configuration at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
