/** Production-safe SQLite connection configuration. Every connection applies identical settings. */

export interface DatabaseConfig {
  path: string
  readonly?: boolean
  busyTimeout?: number
}

export interface PragmaResult {
  name: string
  value: string
  success: boolean
}

const REQUIRED_PRAGMAS: Array<{ name: string; value: string }> = [
  { name: "journal_mode", value: "WAL" },
  { name: "foreign_keys", value: "ON" },
  { name: "busy_timeout", value: "5000" },
  { name: "synchronous", value: "NORMAL" },
  { name: "cache_size", value: "-64000" },
  { name: "journal_size_limit", value: "67108864" },
]

export { REQUIRED_PRAGMAS }
