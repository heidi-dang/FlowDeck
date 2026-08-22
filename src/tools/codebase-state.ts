import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { writeFileSync, existsSync, readdirSync, mkdirSync } from "fs"
import { readFile, stat } from "fs/promises"
import { join, dirname } from "path"
import { resolveCodebasePath, getCanonicalRoot } from "./path-jail"

const CODEBASE_DIR = ".codebase"

export function codebaseDir(directory: string): string {
  const canonicalRoot = getCanonicalRoot(directory)
  return join(canonicalRoot, CODEBASE_DIR)
}

function codebaseFilePath(directory: string, filename: string, forWrite: boolean = false): string {
  return resolveCodebasePath(directory, filename, { forWrite })
}

function listCodebaseFiles(directory: string): string[] {
  const base = codebaseDir(directory)
  if (!existsSync(base)) return []
  return readdirSync(base).filter(f => f.endsWith(".md") || f.endsWith(".json"))
}

async function readCodebaseContext(dir: string, files: string[]): Promise<Record<string, string | { error: string }>> {
  const results: Record<string, string | { error: string }> = {}
  await Promise.all(
    files.map(async (file) => {
      try {
        const filePath = codebaseFilePath(dir, file, false)
        const fileStat = await stat(filePath)
        if (fileStat.isDirectory()) {
          results[file] = { error: `Is a directory: ${file}` }
          return
        }
        results[file] = await readFile(filePath, "utf-8")
      } catch (error: any) {
        if (error.code === "ENOENT") {
          results[file] = { error: `File not found: ${file}` }
        } else {
          results[file] = { error: error.message }
        }
      }
    })
  )
  return results
}

async function updateCodebaseFile(dir: string, filename: string, content: string): Promise<Record<string, unknown>> {
  const filePath = codebaseFilePath(dir, filename, true)
  const targetDir = dirname(filePath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }
  writeFileSync(filePath, content, "utf-8")
  return { success: true, file: filename, written_at: new Date().toISOString() }
}

async function codebaseExists(dir: string): Promise<{ exists: boolean; files: string[] }> {
  const base = codebaseDir(dir)
  if (!existsSync(base)) {
    return { exists: false, files: [] }
  }
  const files = listCodebaseFiles(dir)
  return { exists: true, files }
}

export const codebaseStateTool: ToolDefinition = tool({
  description: "Manage .codebase/ directory: read files, write files, check existence",
  args: {
    action: tool.schema.enum(["read", "write", "exists"]),
    files: tool.schema.array(tool.schema.string()).optional(),
    filename: tool.schema.string().optional(),
    content: tool.schema.string().optional(),
  },
  async execute(args, context): Promise<string> {
    const dir = context.directory ?? process.cwd()
    let result: unknown
    try {
      switch (args.action) {
        case "read":
          result = await readCodebaseContext(dir, args.files ?? [])
          break
        case "write":
          if (!args.filename) {
            result = { error: "Filename is required for write action", success: false }
          } else {
            result = await updateCodebaseFile(dir, args.filename, args.content ?? "")
          }
          break
        case "exists":
          result = await codebaseExists(dir)
          break
      }
    } catch (err: any) {
      result = { error: err.message, success: false }
    }
    return JSON.stringify(result)
  },
})
