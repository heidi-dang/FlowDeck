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
 *
 * Production hardening:
 * - Content-hash-based IDs: identical content produces the same ID.
 * - Deduplication: artifacts with identical content are stored once.
 * - Integrity checking: hash verification detects corrupted files.
 * - LRU memory management: bounded in-memory cache with disk fallback.
 * - Safe pruning: oldest disk artifacts removed when maxDiskFiles exceeded.
 */

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export interface Artifact {
  id: string
  sessionID: string
  toolName: string
  createdAt: string
  content: string
  length: number
  summary: string
  type: "tool_output" | "build_log" | "diff" | "inventory"
  /** SHA-256 hex digest of content for integrity verification. */
  hash: string
}

export interface ArtifactStoreOptions {
  baseDir?: string
  /** Max number of artifacts to keep in memory (LRU eviction). Default: 200. */
  maxInMemory?: number
  /** Max number of artifact files to retain on disk. Oldest pruned first. Default: 1000. */
  maxDiskFiles?: number
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

/** Calculate SHA-256 hex digest of content. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

/**
 * Determine if an artifact ID uses the content-hash format.
 * Hash-based IDs end with exactly 12 hex characters.
 */
function isHashBasedId(id: string): boolean {
  return /^art-[a-z-]+-[0-9a-f]{12}$/.test(id)
}

export class ArtifactStore {
  private readonly inMemory = new Map<string, Artifact>()
  /** Insertion-order tracking for LRU eviction. */
  private readonly insertionOrder: string[] = []
  private readonly baseDir: string
  private readonly maxInMemory: number
  private readonly maxDiskFiles: number
  private storesSinceLastPrune = 0

  constructor(opts?: ArtifactStoreOptions) {
    this.baseDir = opts?.baseDir ?? ""
    this.maxInMemory = opts?.maxInMemory ?? 200
    this.maxDiskFiles = opts?.maxDiskFiles ?? 1000
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
   *
   * Artifacts with identical content share the same hash-based ID.
   * A second call with identical content returns the existing artifact
   * without writing to disk again (deduplication).
   */
  store(
    sessionID: string,
    toolName: string,
    content: string,
    type: Artifact["type"] = "tool_output"
  ): Artifact {
    const hash = sha256(content)
    const id = `art-${type.replace("_", "-")}-${hash.slice(0, 12)}`

    // ── Deduplication: return existing artifact if content is identical ──
    const existing = this.inMemory.get(id)
    if (existing) {
      this.touchLru(id)
      return existing
    }

    // Check disk for existing artifact (deduplication across memory evictions)
    if (this.baseDir) {
      const filePath = join(this.baseDir, `${id}.json`)
      if (existsSync(filePath)) {
        const loaded = this.loadFromDisk(filePath, id)
        if (loaded) {
          this.addToMemory(id, loaded)
          return loaded
        }
        // Corrupted file: fall through to recreate
      }
    }

    // ── New artifact ─────────────────────────────────────────────────────
    const artifact: Artifact = {
      id,
      sessionID,
      toolName,
      createdAt: new Date().toISOString(),
      content,
      length: content.length,
      summary: buildSummary(content),
      type,
      hash,
    }

    this.addToMemory(id, artifact)

    if (this.baseDir) {
      try {
        const filePath = join(this.baseDir, `${id}.json`)
        writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf-8")
      } catch {
        // File write failure is non-fatal; in-memory is authoritative.
      }
    }

    // ── Periodic disk pruning ─────────────────────────────────────────────
    this.storesSinceLastPrune++
    if (this.storesSinceLastPrune >= 50) {
      this.storesSinceLastPrune = 0
      this.pruneDisk()
    }

    return artifact
  }

  /**
   * Retrieve a previously stored artifact by id.
   *
   * Returns null when:
   * - The id is not found in memory or on disk.
   * - The file exists but is corrupted (JSON parse failure or hash mismatch).
   *   The corrupted file is deleted automatically.
   */
  get(id: string): Artifact | null {
    const cached = this.inMemory.get(id)
    if (cached) {
      this.touchLru(id)
      return cached
    }

    if (this.baseDir) {
      const filePath = join(this.baseDir, `${id}.json`)
      if (existsSync(filePath)) {
        const loaded = this.loadFromDisk(filePath, id)
        if (loaded) {
          this.addToMemory(id, loaded)
          return loaded
        }
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
    this.insertionOrder.length = 0
  }

  /**
   * Remove the oldest disk artifacts when the file count exceeds maxDiskFiles.
   * Returns the number of files removed.
   */
  pruneDisk(): number {
    if (!this.baseDir) return 0
    try {
      const files = readdirSync(this.baseDir)
        .filter(f => f.startsWith("art-") && f.endsWith(".json"))
        .map(f => {
          const fullPath = join(this.baseDir, f)
          try {
            return { path: fullPath, mtime: statSync(fullPath).mtimeMs }
          } catch {
            return null
          }
        })
        .filter((f): f is { path: string; mtime: number } => f !== null)

      if (files.length <= this.maxDiskFiles) return 0

      // Sort oldest first
      files.sort((a, b) => a.mtime - b.mtime)
      const toRemove = files.slice(0, files.length - this.maxDiskFiles)
      let removed = 0
      for (const f of toRemove) {
        try {
          unlinkSync(f.path)
          removed++
        } catch {}
      }
      return removed
    } catch {
      return 0
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private loadFromDisk(filePath: string, id: string): Artifact | null {
    try {
      const raw = readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw) as Artifact

      // Structural validation
      if (
        !parsed ||
        typeof parsed.id !== "string" ||
        typeof parsed.content !== "string" ||
        typeof parsed.hash !== "string"
      ) {
        throw new Error("Missing required fields")
      }

      // Integrity: verify hash matches content for hash-based IDs
      if (isHashBasedId(id)) {
        const expectedHashPrefix = id.split("-").pop() ?? ""
        const actualHash = sha256(parsed.content)
        if (!actualHash.startsWith(expectedHashPrefix)) {
          throw new Error(`Hash mismatch: expected prefix ${expectedHashPrefix}, got ${actualHash.slice(0, 12)}`)
        }
      }

      return parsed
    } catch {
      // Corrupted or tampered file — delete it so it doesn't poison the cache
      try { unlinkSync(filePath) } catch {}
      return null
    }
  }

  private addToMemory(id: string, artifact: Artifact): void {
    if (this.inMemory.has(id)) {
      this.touchLru(id)
      return
    }
    this.inMemory.set(id, artifact)
    this.insertionOrder.push(id)
    this.evictMemoryIfNeeded()
  }

  private touchLru(id: string): void {
    const idx = this.insertionOrder.indexOf(id)
    if (idx !== -1) {
      this.insertionOrder.splice(idx, 1)
      this.insertionOrder.push(id)
    }
  }

  private evictMemoryIfNeeded(): void {
    while (this.inMemory.size > this.maxInMemory) {
      const oldest = this.insertionOrder.shift()
      if (oldest) this.inMemory.delete(oldest)
    }
  }
}

let globalStore: ArtifactStore | null = null

export function getArtifactStore(baseDir?: string): ArtifactStore {
  if (!globalStore || (baseDir && globalStore.getBaseDir() !== baseDir)) {
    globalStore = new ArtifactStore({ baseDir })
  }
  return globalStore
}
