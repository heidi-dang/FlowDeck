/** Central migration registry. Every migration is registered here with its SQL and checksum. */

import { computeChecksum } from "./migration-checksum"
import { SCHEMA_V_0_2_6 } from "./schema-embed"
import { MIGRATION_V2_REPLAY_SQL } from "./migration-v2-replay"

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
  {
    version: 2,
    name: "replay_records_v0.2.7",
    sql: MIGRATION_V2_REPLAY_SQL,
    checksum: computeChecksum(MIGRATION_V2_REPLAY_SQL),
  },
]
