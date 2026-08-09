/** Central migration registry. Every migration is registered here with its SQL and checksum. */

import { computeChecksum } from "./migration-checksum"
import { SCHEMA_V_0_2_6 } from "./schema-embed"
import { MIGRATION_V2_REPLAY_SQL } from "./migration-v2-replay"
import { MIGRATION_V3_EXECUTION_SQL } from "./migration-v3-execution"
import { MIGRATION_V4_PERFORMANCE_SQL } from "./migration-v4-performance"

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
  {
    version: 3,
    name: "execution_runtime_v0.2.8",
    sql: MIGRATION_V3_EXECUTION_SQL,
    checksum: computeChecksum(MIGRATION_V3_EXECUTION_SQL),
  },
  {
    version: 4,
    name: "agent_performance_v0.2.9",
    sql: MIGRATION_V4_PERFORMANCE_SQL,
    checksum: computeChecksum(MIGRATION_V4_PERFORMANCE_SQL),
  },
]
