/** Central migration registry. Every migration is registered here with its SQL and checksum. */

import { computeChecksum } from "./migration-checksum"
import { SCHEMA_V_0_2_6 } from "./schema-embed"

export interface MigrationEntry {
  version: number
  name: string
  sql: string
  checksum: string
}

export const MIGRATIONS: MigrationEntry[] = [
  {
    version: 1,
    name: "initial_schema_v0.2.6",
    sql: SCHEMA_V_0_2_6,
    checksum: computeChecksum(SCHEMA_V_0_2_6),
  },
]
