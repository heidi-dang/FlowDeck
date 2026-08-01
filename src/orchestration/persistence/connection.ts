/**
 * Database connection management.
 * Every connection is configured with identical production-safe settings.
 * Connections are cached by resolved path.
 */

import { Database } from "bun:sqlite"
import { resolve } from "path"
import { REQUIRED_PRAGMAS, type DatabaseConfig, type PragmaResult } from "./configuration"
import { PersistenceError } from "./errors"

const CONNECTIONS = new Map<string, Database>()

export function openConnection(config: DatabaseConfig): Database {
  const isMemory = config.path === ':memory:' || config.path.endsWith('/:memory:');
  const key = isMemory ? `:memory:${Math.random()}` : resolve(config.path);
  if (!isMemory) {
    const existing = CONNECTIONS.get(key);
    if (existing) return existing;
  }

  const db = new Database(config.path === ':memory:' ? ':memory:' : key, { create: true });

  // Apply pragmas immediately
  for (const p of REQUIRED_PRAGMAS) {
    db.run("PRAGMA " + p.name + " = " + p.value)
  }

  // bun:sqlite pragma read returns integers for boolean-valued pragmas
  // (1=ON, 0=OFF, etc.) while our config stores string values. Map both.
  const PRAGMA_VALUE_MAP: Record<string, Record<string, string>> = {
    foreign_keys: { "1": "on", "0": "off" },
    synchronous: { "0": "off", "1": "normal", "2": "full", "3": "extra" },
    journal_mode: { "delete": "delete", "truncate": "truncate", "persist": "persist", "wal": "wal", "memory": "memory", "off": "off" },
  }

  // Verify applied pragmas
  const failures: PragmaResult[] = []

  for (const p of REQUIRED_PRAGMAS) {
    try {
      const result = db.query("PRAGMA " + p.name).get() as Record<string, unknown>
      const raw = Object.values(result ?? {})[0]
      const actual = String(raw ?? "").toLowerCase()
      const actualNormalized = PRAGMA_VALUE_MAP[p.name]?.[actual] ?? actual
      const expected = p.value.toLowerCase()
      if (actualNormalized !== expected && !(p.name === "journal_mode" && (actualNormalized === "wal" || actualNormalized === "memory"))) {
        failures.push({ name: p.name, value: actual + " (normalized: " + actualNormalized + ")", success: false })
      }
    } catch (err) {
      failures.push({ name: p.name, value: String(err), success: false })
    }
  }

  if (failures.length > 0) {
    db.close()
    throw new PersistenceError(
      "SQLite pragma configuration failed:\n" +
        failures.map(f => "  " + f.name + ": expected value, got \"" + f.value + "\"").join("\n")
    )
  }

  CONNECTIONS.set(key, db)
  return db
}

export function closeConnection(path: string): void {
  const key = resolve(path)
  const db = CONNECTIONS.get(key)
  if (db) { db.close(); CONNECTIONS.delete(key) }
}

export function closeAllConnections(): void {
  for (const [, db] of CONNECTIONS) db.close()
  CONNECTIONS.clear()
}

export function getConnectionCount(): number {
  return CONNECTIONS.size
}
