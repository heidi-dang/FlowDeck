import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"

const sql = readFileSync("schema-v0.2.6.sql", "utf8")
const checksum = createHash("sha256").update(sql, "utf8").digest("hex")
const embedded = sql.replace("CREATE TABLE schema_migrations (", "CREATE TABLE IF NOT EXISTS schema_migrations (").replaceAll("`", "\\`")
writeFileSync("src/orchestration/persistence/migrations/schema-embed.ts", `// Auto-generated from schema-v0.2.6.sql - DO NOT EDIT\n// Regenerate: bun run generate:schema\n// Canonical checksum: ${checksum}\n\nexport const SCHEMA_V_0_2_6 = \`${embedded}\`;\nexport const SCHEMA_CHECKSUM = "${checksum}";\n`)
console.log(`Generated, checksum: ${checksum}`)
