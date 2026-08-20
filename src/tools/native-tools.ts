/**
 * Native FlowDeck Fast-Lane and FDX Tool Definitions
 *
 * Provides optimized shell, bash, and native read tools for OpenCode.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { executeShellCommand } from "../services/shell-executor"
import { normalizeShellFailure, describeShellFailure } from "../services/shell-failure"
import { repoIdOf } from "../services/repo-lease-coordinator"
import { executeFdxRedirect } from "../hooks/tool-guard"
import { nativeReadFallback } from "./fdx-shared"

export interface NativeToolsOptions {
  directory: string
}

export function createShellFastLaneTool(options: NativeToolsOptions): ToolDefinition {
  const { directory } = options
  return tool({
    description:
      "Execute a shell command. Recognized read-only commands (cat, sed -n, grep, git status/diff/log, ls) run through the fast lane with no shell spawn; all others run in bash.",
    args: {
      command: tool.schema.string().describe("The shell command to execute."),
      description: tool.schema.string().optional(),
      cwd: tool.schema.string().optional().describe("Working directory (defaults to repo root)."),
    },
    async execute(args: any, context: any) {
      const command = String(args.command ?? "")
      const r = executeShellCommand(command, { cwd: args.cwd ? String(args.cwd) : directory })
      if (r.status === "failed") {
        const info = normalizeShellFailure(r, {
          command,
          sessionID: context?.sessionID ?? "",
          callID: context?.messageID ?? "",
          toolName: "shell",
          repoGeneration: repoIdOf(directory),
        })
        return { output: describeShellFailure(info), metadata: { fdShell: info as unknown as Record<string, unknown> } }
      }
      return r.output
    },
  })
}

export function createBashFastLaneTool(options: NativeToolsOptions): ToolDefinition {
  const { directory } = options
  return tool({
    description: "Execute a bash command via the FlowDeck fast lane (same semantics as the shell tool).",
    args: {
      command: tool.schema.string().describe("The bash command to execute."),
      description: tool.schema.string().optional(),
      cwd: tool.schema.string().optional(),
    },
    async execute(args: any, context: any) {
      const command = String(args.command ?? "")
      const r = executeShellCommand(command, { cwd: args.cwd ? String(args.cwd) : directory })
      if (r.status === "failed") {
        const info = normalizeShellFailure(r, {
          command,
          sessionID: context?.sessionID ?? "",
          callID: context?.messageID ?? "",
          toolName: "bash",
          repoGeneration: repoIdOf(directory),
        })
        return { output: describeShellFailure(info), metadata: { fdShell: info as unknown as Record<string, unknown> } }
      }
      return r.output
    },
  })
}

export function createReadNativeTool(options: NativeToolsOptions): ToolDefinition {
  const { directory } = options
  return tool({
    description: "Read a file from the workspace. Token-optimized and routed to FDX when available.",
    args: {
      filePath: tool.schema.string().optional().describe("Path to the file to read."),
      file_path: tool.schema.string().optional(),
      path: tool.schema.string().optional(),
      file: tool.schema.string().optional(),
      mode: tool.schema.enum(["auto", "raw", "prototype", "deep"]).optional(),
      limit: tool.schema.number().optional(),
      offset: tool.schema.number().optional(),
      symbol: tool.schema.string().optional(),
      with_deps: tool.schema.boolean().optional(),
      format: tool.schema.enum(["text", "json"]).optional(),
      no_cache: tool.schema.boolean().optional(),
    },
    async execute(args: any, context: any) {
      const filePath =
        (args?.filePath as string | undefined) ??
        (args?.file_path as string | undefined) ??
        (args?.path as string | undefined) ??
        (args?.file as string | undefined)
      if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required for read tool")
      }
      const targetPath = filePath.trim()
      const fdxRoute = await executeFdxRedirect(
        "read",
        { ...args, file: targetPath },
        {
          directory,
          sessionID: context?.sessionID,
          agent: context?.agent,
        }
      )
      if (fdxRoute?.executed && fdxRoute.output !== undefined) {
        return fdxRoute.output
      }
      if (fdxRoute && !fdxRoute.executed && fdxRoute.error) {
        throw new Error(fdxRoute.error)
      }
      return nativeReadFallback(targetPath, args?.limit, args?.offset, directory)
    },
  })
}
