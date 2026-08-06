import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createHash } from "crypto"

import { validateArchitectureFreeze } from "../scripts/validate-architecture-freeze.mjs"

const ROOT = process.cwd()

function sha256(buf: string | Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

/** Build a temp root that mirrors the canonical artifacts (optionally tampered). */
function buildFixtureRoot(opts: {
  tamperArch?: boolean
  tamperSchema?: boolean
  dropEmbed?: boolean
  manifestTables?: number
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-freeze-test-"))
  copyFileSync(join(ROOT, "architecture-freeze-v0.2.6.json"), join(dir, "architecture-freeze-v0.2.6.json"))
  copyFileSync(join(ROOT, "schema-v0.2.6.sql"), join(dir, "schema-v0.2.6.sql"))
  copyFileSync(join(ROOT, "NEXT_GEN_ARCHITECTURE_v0.2.6.md"), join(dir, "NEXT_GEN_ARCHITECTURE_v0.2.6.md"))

  if (!opts.dropEmbed) {
    const embedDir = join(dir, "src", "orchestration", "persistence", "migrations")
    mkdirSync(embedDir, { recursive: true })
    copyFileSync(
      join(ROOT, "src", "orchestration", "persistence", "migrations", "schema-embed.ts"),
      join(embedDir, "schema-embed.ts"),
    )
  }

  if (opts.tamperArch) {
    const p = join(dir, "NEXT_GEN_ARCHITECTURE_v0.2.6.md")
    const buf = readFileSync(p)
    buf[5] = buf[5] === 0x58 ? 0x59 : 0x58 // flip a byte
    writeFileSync(p, buf)
  }

  if (opts.tamperSchema) {
    const p = join(dir, "schema-v0.2.6.sql")
    const s = readFileSync(p, "utf8").replace(
      "    duration_ms INTEGER\n",
      "    duration_ms INTEGER, extra_col TEXT\n",
    )
    writeFileSync(p, s)
  }

  if (opts.manifestTables !== undefined) {
    const p = join(dir, "architecture-freeze-v0.2.6.json")
    const m = JSON.parse(readFileSync(p, "utf8"))
    m.tables = opts.manifestTables
    writeFileSync(p, JSON.stringify(m, null, 2))
  }

  return dir
}

describe("Architecture Freeze Validator (tests/architecture-freeze.test.ts)", () => {
  it("passes on the canonical repository artifacts (GREEN)", async () => {
    const result = await validateArchitectureFreeze(ROOT)
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects a tampered architecture file (fail-closed)", async () => {
    const dir = buildFixtureRoot({ tamperArch: true })
    const result = await validateArchitectureFreeze(dir)
    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toMatch(/Architecture SHA mismatch/)
  })

  it("rejects a tampered schema file (fail-closed)", async () => {
    const dir = buildFixtureRoot({ tamperSchema: true })
    const result = await validateArchitectureFreeze(dir)
    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toMatch(/Schema SHA mismatch/)
  })

  it("rejects a missing embedded schema (fail-closed)", async () => {
    const dir = buildFixtureRoot({ dropEmbed: true })
    const result = await validateArchitectureFreeze(dir)
    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toMatch(/Embedded schema missing/)
  })

  it("rejects inventory drift (manifest claims wrong table count)", async () => {
    const dir = buildFixtureRoot({ manifestTables: 54 })
    const result = await validateArchitectureFreeze(dir)
    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toMatch(/Table count 53 != pinned 54/)
  })

  it("rejects a missing manifest (fail-closed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-freeze-empty-"))
    const result = await validateArchitectureFreeze(dir)
    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toMatch(/Missing manifest/)
  })

  it("pinned architecture hash matches the canonical file bytes", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "architecture-freeze-v0.2.6.json"), "utf8"))
    const actual = sha256(readFileSync(join(ROOT, manifest.architectureFile)))
    expect(actual).toBe(manifest.architectureSha256)
  })

  it("pinned schema hash matches the canonical schema file bytes", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "architecture-freeze-v0.2.6.json"), "utf8"))
    const actual = sha256(readFileSync(join(ROOT, manifest.schemaFile)))
    expect(actual).toBe(manifest.schemaSha256)
  })

  it("embedded schema matches canonical after the sanctioned IF NOT EXISTS normalization", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "architecture-freeze-v0.2.6.json"), "utf8"))
    const embed = readFileSync(join(ROOT, "src", "orchestration", "persistence", "migrations", "schema-embed.ts"), "utf8")
    const m = embed.match(/export const SCHEMA_V_0_2_6 = `([\s\S]*?)`;/)
    expect(m).not.toBeNull()
    const normalized = m![1].replace(
      "CREATE TABLE IF NOT EXISTS schema_migrations (",
      "CREATE TABLE schema_migrations (",
    )
    expect(sha256(normalized)).toBe(manifest.schemaSha256)
  })
})
