/**
 * Architecture freeze validator (fail-closed).
 *
 * Verifies that the canonical v0.2.6 architecture and schema artifacts in the
 * repository match the pinned SHA-256 hashes and object inventories in
 * architecture-freeze-v0.2.6.json. The validator never regenerates or rewrites
 * any pinned artifact — it only checks. Any mismatch exits non-zero.
 *
 * Checks:
 *   1. Manifest is present, parseable, and self-consistent.
 *   2. architectureFile bytes == architectureSha256.
 *   3. schemaFile bytes == schemaSha256.
 *   4. Embedded schema (src/orchestration/persistence/migrations/schema-embed.ts)
 *      carries the same canonical checksum as schemaFile.
 *   5. Schema executes cleanly in a fresh SQLite database (integrity ok).
 *   6. Actual table/trigger/index counts == pinned counts.
 *   7. Actual object name inventories == pinned inventories.
 *   8. FK violations == 0 after schema application.
 *
 * Usage:
 *   node scripts/validate-architecture-freeze.mjs [--root <path>]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MANIFEST_FILE = "architecture-freeze-v0.2.6.json";
const SCHEMA_EMBED_FILE = "src/orchestration/persistence/migrations/schema-embed.ts";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function loadManifest(root) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) {
    return { ok: false, errors: [`Missing manifest: ${MANIFEST_FILE}`] };
  }
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, errors: [`Manifest is not valid JSON: ${err.message}`] };
  }
}

/**
 * Validate the freeze. Returns { ok, errors } — never throws.
 */
/** @returns {Promise<{ok: boolean, errors: string[]}>} */
export async function validateArchitectureFreeze(root = ROOT) {
  const errors = [];
  const loaded = loadManifest(root);
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  const manifest = loaded.manifest;

  // 1. Manifest self-consistency
  const required = [
    "architectureVersion",
    "architectureFile",
    "architectureSha256",
    "schemaFile",
    "schemaSha256",
    "tables",
    "triggers",
    "indexes",
    "objects",
  ];
  for (const key of required) {
    if (!(key in manifest)) errors.push(`Manifest missing key: ${key}`);
  }
  if (manifest.architectureVersion !== "0.2.6") {
    errors.push(`Unexpected architectureVersion: ${manifest.architectureVersion}`);
  }
  const objShape = manifest.objects && typeof manifest.objects === "object";
  if (!objShape) {
    errors.push("Manifest objects block missing");
  } else {
    for (const kind of ["tables", "triggers", "indexes"]) {
      if (!Array.isArray(manifest.objects[kind])) {
        errors.push(`Manifest objects.${kind} must be an array`);
      }
    }
  }

  // 2. Architecture file hash
  const archPath = join(root, manifest.architectureFile);
  if (!existsSync(archPath)) {
    errors.push(`Architecture file missing: ${manifest.architectureFile}`);
  } else {
    const actual = sha256(readFileSync(archPath));
    if (actual !== manifest.architectureSha256) {
      errors.push(
        `Architecture SHA mismatch: pinned ${manifest.architectureSha256} != actual ${actual}`
      );
    }
  }

  // 3. Schema file hash
  const schemaPath = join(root, manifest.schemaFile);
  if (!existsSync(schemaPath)) {
    errors.push(`Schema file missing: ${manifest.schemaFile}`);
  } else {
    const schemaBytes = readFileSync(schemaPath);
    const actual = sha256(schemaBytes);
    if (actual !== manifest.schemaSha256) {
      errors.push(
        `Schema SHA mismatch: pinned ${manifest.schemaSha256} != actual ${actual}`
      );
    }

    // 4. Embedded schema checksum parity
    const embedPath = join(root, SCHEMA_EMBED_FILE);
    if (!existsSync(embedPath)) {
      errors.push(`Embedded schema missing: ${SCHEMA_EMBED_FILE}`);
    } else {
      const embed = readFileSync(embedPath, "utf8");
      const m = embed.match(/Canonical checksum:\s*([a-f0-9]{64})/);
      if (!m) {
        errors.push(`Embedded schema has no canonical checksum comment in ${SCHEMA_EMBED_FILE}`);
      } else if (m[1] !== manifest.schemaSha256) {
        errors.push(
          `Embedded schema checksum ${m[1]} != pinned schema ${manifest.schemaSha256}`
        );
      }
      // Verify the embedded SQL bytes hash to the pinned hash, after applying the
      // single sanctioned idempotency normalization: the migration runner
      // pre-creates the schema_migrations ledger table (CREATE TABLE IF NOT EXISTS),
      // so the embedded migration SQL must guard that one table with IF NOT EXISTS.
      // Normalizing that guard back to the canonical form must yield the pinned hash.
      const embSql = embed.match(/export const SCHEMA_V_0_2_6 = `([\s\S]*?)`;/);
      if (embSql) {
        const normalized = embSql[1].replace(
          "CREATE TABLE IF NOT EXISTS schema_migrations (",
          "CREATE TABLE schema_migrations ("
        );
        if (sha256(normalized) !== manifest.schemaSha256) {
          errors.push(
            "Embedded SCHEMA_V_0_2_6 bytes (after sanctioned IF NOT EXISTS normalization) " +
              "do not hash to the pinned schema SHA"
          );
        }
      } else {
        errors.push("Embedded SCHEMA_V_0_2_6 export not found in " + SCHEMA_EMBED_FILE);
      }
    }

    // 5–8. Runtime inventory via fresh SQLite execution
    try {
      const { Database } = await import("bun:sqlite");
      const dbPath = join("/tmp", `fd-freeze-check-${process.pid}-${Date.now()}.db`);
      const db = new Database(dbPath);
      try {
        db.exec(readFileSync(schemaPath, "utf8"));

        const integrity = db.query("PRAGMA integrity_check").get();
        if (integrity.integrity_check !== "ok") {
          errors.push(`Schema integrity_check != ok: ${integrity.integrity_check}`);
        }

        const fkViolations = db.query("PRAGMA foreign_key_check").all();
        if (fkViolations.length > 0) {
          errors.push(`FK violations after schema apply: ${fkViolations.length}`);
        }

        const tables = db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all().map((r) => r.name);
        const triggers = db
          .query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
          .all().map((r) => r.name);
        const indexes = db
          .query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all().map((r) => r.name);

        if (tables.length !== manifest.tables) {
          errors.push(`Table count ${tables.length} != pinned ${manifest.tables}`);
        }
        if (triggers.length !== manifest.triggers) {
          errors.push(`Trigger count ${triggers.length} != pinned ${manifest.triggers}`);
        }
        if (indexes.length !== manifest.indexes) {
          errors.push(`Index count ${indexes.length} != pinned ${manifest.indexes}`);
        }

        const diffSet = (kind, actual, pinned) => {
          const a = new Set(actual);
          const p = new Set(pinned);
          const missing = [...p].filter((x) => !a.has(x));
          const extra = [...a].filter((x) => !p.has(x));
          if (missing.length) {
            errors.push(`Pinned ${kind} missing from applied schema: ${missing.join(", ")}`);
          }
          if (extra.length) {
            errors.push(`Unpinned ${kind} present in applied schema: ${extra.join(", ")}`);
          }
        };
        diffSet("tables", tables, manifest.objects.tables);
        diffSet("triggers", triggers, manifest.objects.triggers);
        diffSet("indexes", indexes, manifest.objects.indexes);
      } finally {
        db.close();
      }
    } catch (err) {
      errors.push(`Schema runtime inventory check failed: ${err.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// CLI entry
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argRoot = process.argv.indexOf("--root");
  const root = argRoot !== -1 ? process.argv[argRoot + 1] : ROOT;
  const result = await validateArchitectureFreeze(root);
  if (!result.ok) {
    console.error("ARCHITECTURE FREEZE: FAILED");
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log("ARCHITECTURE FREEZE: PASS (canonical v0.2.6 artifacts verified)");
  process.exit(0);
}
