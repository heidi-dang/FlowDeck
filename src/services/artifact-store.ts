/**
 * Artifact Store — in-memory + optionally file-backed storage for
 * externalized tool outputs and large context payloads.
 *
 * When a tool result exceeds the configured maxToolOutputChars threshold,
 * the full content is archived here and the model receives only a compact
 * reference marker. The model can retrieve the original via fdx-context
 * action:read_artifact.
 *
 * The store is instantiated once per plugin run (like TokenBudgetRuntime)
 * so it is isolated across test runs without static state.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

export interface Artifact {
  id: string
  sessionID: string
  toolName: string
  createdAt: string
  content: string
  length: number
  summary: string
  type: "tool_output" | "build_log" | "diff" | "inventory"
}

/** Build a short representative summary of large tool output content. */
function buildSummary(content: string): string {
  const lines = content.split("\n")
  const errorLines = lines.filter(l => /error|fail|exception|stderr/i.test(l)).slice(0, 5)
  let snippet: string
  if (errorLines.length > 0) {
    snippet = `[Contains Errors]\n${errorLines.join("\n")}`
  } else {
    const head = lines.slice(0, 4).join("\n")
    const tail = lines.length > 4 ? `\n...\n${lines.slice(-3).join("\n")}` : ""
    snippet = head + tail
  }
  return snippet.length > 300 ? snippet.slice(0, 297) + "..." : snippet
}

export class ArtifactStore {
  private readonly inMemory = new Map<string, Artifact>()
  private readonly baseDir: string

  constructor(opts?: { baseDir?: string }) {
    this.baseDir = opts?.baseDir ?? ""
    if (this.baseDir) {
      try {
        mkdirSync(this.baseDir, { recursive: true })
      } catch {}
    }
  }

  getBaseDir(): string {
    return this.baseDir
  }

  /**
   * Store the full content of an oversized tool result and return the
   * Artifact descriptor (stable id, summary, metadata).
   */
  store(
    sessionID: string,
    toolName: string,
    content: string,
    type: Artifact["type"] = "tool_output"
  ): Artifact {
    const id = `art-${type.replace("_", "-")}-${randomUUID().slice(0, 8)}`
    const artifact: Artifact = {
      id,
      sessionID,
      toolName,
      createdAt: new Date().toISOString(),
      content,
      length: content.length,
      summary: buildSummary(content),
      type,
    }

    this.inMemory.set(id, artifact)

    if (this.baseDir) {
      try {
        const filePath = join(this.baseDir, `${id}.json`)
        writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf-8")
      } catch {
        // File write failure is non-fatal; in-memory is authoritative.
      }
    }

    return artifact
  }

  /** Retrieve a previously stored artifact by id. */
  get(id: string): Artifact | null {
    const cached = this.inMemory.get(id)
    if (cached) return cached

    if (this.baseDir) {
      const filePath = join(this.baseDir, `${id}.json`)
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, "utf-8")
          const parsed = JSON.parse(raw) as Artifact
          this.inMemory.set(id, parsed)
          return parsed
        } catch {}
      }
    }

    return null
  }

  /** Number of artifacts held in memory. */
  size(): number {
    return this.inMemory.size
  }

  /** Remove all in-memory artifacts (file-backed copies remain). */
  clear(): void {
    this.inMemory.clear()
  }
}

let globalStore: ArtifactStore | null = null

export function getArtifactStore(baseDir?: string): ArtifactStore {
  if (!globalStore || (baseDir && globalStore.getBaseDir() !== baseDir)) {
    globalStore = new ArtifactStore({ baseDir })
  }
  return globalStore
}

