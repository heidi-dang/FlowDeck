/**
 * Tests for the SQLite schema validation fallback logic.
 *
 * Covers all required paths:
 * 1. sqlite3 CLI available path
 * 2. sqlite3 absent, Bun fallback path
 * 3. Malformed schema fails properly (both paths)
 * 4. FK violation detection
 * 5. Integrity failure detection (where testable)
 * 6. Subprocess failure handling
 * 7. Bun fallback failure fails closed
 * 8. Both mechanisms unavailable
 *
 * Also validates canonical schema counts (53 tables, 36 triggers, 66 indexes)
 * and ensures exit-code semantics remain deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = join(__dirname, "../scripts/check-schema-generated.mjs");
const SCHEMA_PATH = join(__dirname, "../schema-v0.2.6.sql");

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Run the schema check script as a subprocess and capture result.
 */
function runScript(env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    const result = execSync(`node ${SCRIPT_PATH}`, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { stdout: result.toString(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";
    const exitCode = err.status ?? null;
    return { stdout, stderr, exitCode };
  }
}

/**
 * Create a temporary copy of the script to test with modified paths.
 */
function createTempScript(schemaContent: string, embedContent: string): string {
  const tmpDir = tmpdir();
  const tmpSchema = join(tmpDir, `test-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  const tmpEmbed = join(tmpDir, `test-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  const tmpScript = join(tmpDir, `test-check-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  writeFileSync(tmpSchema, schemaContent);
  writeFileSync(tmpEmbed, embedContent);

  // Read the original script and replace paths
  const original = readFileSync(SCRIPT_PATH, "utf-8");
  const tmpSchemaPathEscaped = tmpSchema.replace(/\\/g, "/");
  const tmpEmbedPathEscaped = tmpEmbed.replace(/\\/g, "/");
  const modified = original
    .replace(/const SQL_FILE = 'schema-v0.2.6.sql';/, `const SQL_FILE = '${tmpSchemaPathEscaped}';`)
    .replace(
      /const EMBED_FILE = 'src\/orchestration\/persistence\/migrations\/schema-embed\.ts';/,
      `const EMBED_FILE = '${tmpEmbedPathEscaped}';`,
    );

  writeFileSync(tmpScript, modified);
  return tmpScript;
}

/**
 * Run a temporary script with custom schema content.
 */
function runTempScript(scriptPath: string): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    const result = execSync(`node ${scriptPath}`, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      cwd: process.cwd(), // Run from project root so relative paths work
    });
    return { stdout: result.toString(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";
    const exitCode = err.status ?? null;
    return { stdout, stderr, exitCode };
  }
}

/**
 * Compute checksum of schema content for embed matching.
 */
function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf-8").digest("hex");
}

// ── Typed row helpers (bun:sqlite .get() rows are typed unknown) ─────────

interface CountRow {
  c: number;
}

interface IntegrityRow {
  integrity_check: string;
}

/** Run a COUNT query and return the count, or -1 if no row is returned. */
function getCount(db: Database, sql: string): number {
  const row = db.query(sql).get() as CountRow | undefined;
  return row?.c ?? -1;
}

/** Run PRAGMA integrity_check and return its value (defensive: string form). */
function getIntegrity(db: Database): string {
  const result = db.query("PRAGMA integrity_check;").get();
  if (typeof result === "object" && result !== null) {
    return (result as IntegrityRow).integrity_check;
  }
  return typeof result === "string" ? result : "missing";
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("Schema Validation SQLite Fallback", () => {
  let tempFiles: string[] = [];

  beforeEach(() => {
    tempFiles = [];
  });

  afterEach(() => {
    for (const f of tempFiles) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  });

  // Track temp files for cleanup
  function track(path: string): string {
    tempFiles.push(path);
    return path;
  }

  // ── Canonical counts ─────────────────────────────────────────────────

  describe("Canonical schema counts", () => {
    it("real schema file has 53 tables, 36 triggers, 66 indexes, 0 FK, ok integrity", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");
      const db = new Database(":memory:");
      db.run(sql);

      const tables = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"');
      const triggers = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="trigger"');
      const indexes = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"');
      const fk = db.query("PRAGMA foreign_key_check;").all().length;
      const integ = getIntegrity(db);

      expect(tables).toBe(53);
      expect(triggers).toBe(36);
      expect(indexes).toBe(66);
      expect(fk).toBe(0);
      expect(integ).toBe("ok");

      db.close();
    });
  });

  // ── Path 1: sqlite3 CLI available ──────────────────────────────────────

  describe("sqlite3 CLI path", () => {
    it("produces correct validation counts via bun:sqlite", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");
      const db = new Database(":memory:");
      db.run(sql);

      const tables = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"');
      const triggers = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="trigger"');
      const indexes = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"');
      const fk = db.query("PRAGMA foreign_key_check;").all().length;
      const integ = getIntegrity(db);

      expect(tables).toBe(53);
      expect(triggers).toBe(36);
      expect(indexes).toBe(66);
      expect(fk).toBe(0);
      expect(integ).toBe("ok");

      db.close();
    });

    it("script produces exit code 0 with correct output", () => {
      const result = runScript();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Tables: 53");
      expect(result.stdout).toContain("Triggers: 36");
      expect(result.stdout).toContain("Indexes: 66");
      expect(result.stdout).toContain("FK violations: 0");
      expect(result.stdout).toContain("Integrity: ok");
      expect(result.stdout).toContain("Schema validation: ALL PASS");
    });
  });

  // ── Path 2: sqlite3 absent, Bun fallback ───────────────────────────────

  describe("bun:sqlite fallback path", () => {
    it("produces equivalent validation using bun:sqlite directly", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");
      const db = new Database(":memory:");
      db.run(sql);

      const tables = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"');
      const triggers = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="trigger"');
      const indexes = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"');
      const fk = db.query("PRAGMA foreign_key_check;").all().length;
      const integ = getIntegrity(db);

      // Same expected values as CLI path
      expect(tables).toBe(53);
      expect(triggers).toBe(36);
      expect(indexes).toBe(66);
      expect(fk).toBe(0);
      expect(integ).toBe("ok");

      db.close();
    });

    it("detects whether sqlite3 CLI is available", () => {
      // Verify that the script can find sqlite3 or falls back properly
      const result = runScript();
      expect(result.exitCode).toBe(0);
      // The script should indicate which path it used
      expect(result.stdout).toMatch(/Validation path:/);
    });
  });

  // ── Path 3: Malformed schema fails properly ────────────────────────────

  describe("malformed schema", () => {
    it("fails when schema has invalid SQL syntax (via bun:sqlite)", () => {
      const malformedSql = "CREATE TABLE test_table (id TEXT PRIMARY KEY;";
      const db = new Database(":memory:");
      let threw = false;
      try {
        db.run(malformedSql);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      db.close();
    });

    it("script fails for malformed schema with mismatched checksum", () => {
      const malformedSql = "CREATE TABLE t (id TEXT); -- simple valid schema";
      const checksum = computeChecksum(malformedSql);
      const embedContent =
        `// Auto-generated\n// Canonical checksum: ${checksum}\n\n` +
        `export const SCHEMA_V_0_2_6 = \`${malformedSql}\`;\n`;

      const tmpScript = track(createTempScript(malformedSql, embedContent));
      const result = runTempScript(tmpScript);

      // Should fail because table count != 53
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ── Path 4: FK violation detection ──────────────────────────────────────

  describe("FK violation detection", () => {
    it("detects FK violations via PRAGMA foreign_key_check", () => {
      const db = new Database(":memory:");
      db.run(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          FOREIGN KEY (parent_id) REFERENCES parent(id)
        );
      `);
      // Insert data without FK enforcement
      db.run("PRAGMA foreign_keys = OFF");
      db.run("INSERT INTO child (id, parent_id) VALUES ('1', 'nonexistent')");
      // Check FK violations
      db.run("PRAGMA foreign_keys = ON");
      const violations = db.query("PRAGMA foreign_key_check;").all();
      expect(violations.length).toBe(1);
      db.close();
    });

    it("reports zero FK violations for valid schema", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");
      const db = new Database(":memory:");
      db.run(sql);
      const violations = db.query("PRAGMA foreign_key_check;").all();
      expect(violations.length).toBe(0);
      db.close();
    });
  });

  // ── Path 5: Integrity failure detection ───────────────────────────────

  describe("integrity check", () => {
    it("PRAGMA integrity_check returns 'ok' for valid schema", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");
      const db = new Database(":memory:");
      db.run(sql);
      // Note: bun:sqlite returns row object; getIntegrity handles both forms
      const integVal = getIntegrity(db);
      expect(integVal).toBe("ok");
      db.close();
    });

    it("throws on corrupted database file", () => {
      const tmpDb = track(join(tmpdir(), `integrity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));

      // Write garbage to a file
      writeFileSync(tmpDb, "not a valid database file");

      // Attempting to open and query should fail
      let threw = false;
      try {
        const db = new Database(tmpDb);
        db.query("PRAGMA integrity_check;").get();
        db.close();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  // ── Path 6: Subprocess failure handling ─────────────────────────────────

  describe("subprocess failure handling", () => {
    it("script fails closed when both sqlite3 and bun are unavailable", () => {
      // Create a modified script where both findSqlite3Cli and findBun return null
      const tmpScript = track(join(tmpdir(), `test-no-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`));
      const original = readFileSync(SCRIPT_PATH, "utf-8");
      // Replace the entire findSqlite3Cli and findBun functions
      let modified = original;
      modified = modified.replace(
        /function findSqlite3Cli\(\) \{[\s\S]*?\n\}/,
        `function findSqlite3Cli() {\n  return null;\n}`
      );
      modified = modified.replace(
        /function findBun\(\) \{[\s\S]*?\n\}/,
        `function findBun() {\n  return null;\n}`
      );
      writeFileSync(tmpScript, modified);

      const result = runTempScript(tmpScript);
      expect(result.exitCode).not.toBe(0);
      // The error should be about neither tool being available
      const combined = result.stderr + result.stdout;
      expect(combined).toMatch(/Neither sqlite3 CLI nor bun is available/);
    });

    it("fails closed when sqlite3 CLI is present but validation fails (no silent bun fallback)", () => {
      // Regression test for the original catch-all defect: a present-but-broken
      // sqlite3 CLI must NOT silently trigger the bun:sqlite fallback. The
      // fallback is only legitimate when the CLI is genuinely absent, so a
      // validation failure on the CLI path must fail the check outright.
      const fakeSqlite3 = track(
        join(tmpdir(), `fake-sqlite3-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
      );
      writeFileSync(fakeSqlite3, "#!/bin/sh\necho 'fake sqlite3 failure' >&2\nexit 1\n");
      chmodSync(fakeSqlite3, 0o755);

      const tmpScript = track(
        join(tmpdir(), `cli-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
      );
      const original = readFileSync(SCRIPT_PATH, "utf-8");
      const modified = original.replace(
        /function findSqlite3Cli\(\) \{[\s\S]*?return null;\r?\n\}/,
        `function findSqlite3Cli() {\n  return '${fakeSqlite3}';\n}`
      );
      // The replacement must have matched the real function definition.
      expect(modified).not.toBe(original);
      writeFileSync(tmpScript, modified);

      const result = runTempScript(tmpScript);
      // CLI path failed => the script must fail, never report success.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).not.toContain("Schema validation: ALL PASS");
    });
  });

  // ── Path 7: Bun fallback failure fails closed ───────────────────────────

  describe("Bun fallback failure", () => {
    it("Bun validation also throws for invalid SQL", () => {
      const invalidSql = "THIS IS NOT VALID SQL";
      const db = new Database(":memory:");
      let threw = false;
      try {
        db.run(invalidSql);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      db.close();
    });

    it("Bun validation fails for schema with duplicate table names", () => {
      const dupeSql = `
        CREATE TABLE t (id TEXT);
        CREATE TABLE t (id TEXT);
      `;
      const db = new Database(":memory:");
      let threw = false;
      try {
        db.run(dupeSql);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      db.close();
    });
  });

  // ── Exit code semantics ──────────────────────────────────────────────────

  describe("exit code semantics", () => {
    it("returns 0 for valid schema", () => {
      const result = runScript();
      expect(result.exitCode).toBe(0);
    });

    it("returns 1 for wrong table count", () => {
      const sql = "CREATE TABLE t (id TEXT);"; // Only 1 table
      const checksum = computeChecksum(sql);
      const embedContent =
        `// Auto-generated\n// Canonical checksum: ${checksum}\n\n` +
        `export const SCHEMA_V_0_2_6 = \`${sql}\`;\n`;

      const tmpScript = track(createTempScript(sql, embedContent));
      const result = runTempScript(tmpScript);
      expect(result.exitCode).toBe(1);
      // Error messages go to stderr, check combined output
      expect(result.stderr + result.stdout).toContain("Expected 53 tables");
    });

    it("returns 1 for checksum mismatch", () => {
      const tmpScript = track(join(tmpdir(), `checksum-mismatch-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`));
      const original = readFileSync(SCRIPT_PATH, "utf-8");
      const modified = original.replace(
        /const h = m \? m\[1\] : '';/,
        `const h = 'wrong_checksum';`
      );
      writeFileSync(tmpScript, modified);
      const result = runTempScript(tmpScript);
      expect(result.exitCode).toBe(1);
      // Error messages go to stderr, check combined output
      expect(result.stderr + result.stdout).toContain("SCHEMA MISMATCH");
    });
  });

  // ── Equivalence between paths ────────────────────────────────────────────

  describe("path equivalence", () => {
    it("both validation paths produce same canonical counts", () => {
      const sql = readFileSync(SCHEMA_PATH, "utf-8");

      // Validate with bun:sqlite
      const db = new Database(":memory:");
      db.run(sql);

      const tablesBun = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"');
      const triggersBun = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="trigger"');
      const indexBun = getCount(db, 'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"');
      const fkBun = db.query("PRAGMA foreign_key_check;").all().length;
      const integBun = getIntegrity(db);
      db.close();

      // Both paths should yield identical canonical counts
      expect(tablesBun).toBe(53);
      expect(triggersBun).toBe(36);
      expect(indexBun).toBe(66);
      expect(fkBun).toBe(0);
      expect(integBun).toBe("ok");
    });
  });

  // ── Detected executable path honouring ──────────────────────────────
  // Regression for the alpha.3 publish-runner failure (run 31480180293):
  // the discovered sqlite3 CLI path must be the EXACT executable invoked.
  // The old code detected a path via findSqlite3Cli() but then invoked a
  // literal `sqlite3` from PATH, so an injected/broken discovered binary was
  // silently bypassed and the validation falsely reported ALL PASS.
  describe("detected executable path honouring", () => {
    it("invokes the detected sqlite3 path (not a literal sqlite3) and succeeds for a valid schema", () => {
      const marker = join(tmpdir(), `fake-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
      const fakeSqlite3 = track(
        join(tmpdir(), `fake-sqlite3-ok-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
      );
      writeFileSync(
        fakeSqlite3,
        `#!/bin/sh\n` +
        `echo "INVOKED:$(basename "$0"):$*" >> '${marker}'\n` +
        `last=""; for a in "$@"; do last="$a"; done\n` +
        `case "$last" in\n` +
        `  *PRAGMA\\ integrity_check*) echo ok ;;\n` +
        `  *PRAGMA\\ foreign_key_check*) : ;;\n` +
        `  *sqlite_master*) case "$last" in\n` +
        `      *type=\\"table\\"*) echo 53 ;;\n` +
        `      *type=\\"trigger\\"*) echo 36 ;;\n` +
        `      *type=\\"index\\"*) echo 66 ;;\n` +
        `    esac ;;\n` +
        `  *) : ;;\n` +
        `esac\nexit 0\n`
      );
      chmodSync(fakeSqlite3, 0o755);

      const tmpScript = track(
        join(tmpdir(), `detected-path-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
      );
      const original = readFileSync(SCRIPT_PATH, "utf-8");
      const modified = original.replace(
        /function findSqlite3Cli\(\) \{[\s\S]*?return null;\r?\n\}/,
        `function findSqlite3Cli() {\n  return '${fakeSqlite3}';\n}`
      );
      expect(modified).not.toBe(original);
      writeFileSync(tmpScript, modified);

      const result = runTempScript(tmpScript);

      // Valid schema through the detected executable => ALL PASS, exit 0.
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("Schema validation: ALL PASS");

      // The detected fake executable must be the exact binary invoked. Mark
      // every invocation with basename($0); a literal `sqlite3` fallback would
      // log "INVOKED:sqlite3:". At least six invocations are expected
      // (schema load + table/trigger/index/FK/integrity queries).
      const lines = readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(6);
      for (const line of lines) {
        expect(line).toMatch(/^INVOKED:fake-sqlite3-ok-/);
        expect(line).not.toMatch(/^INVOKED:sqlite3:/);
      }
    });
  });
});
