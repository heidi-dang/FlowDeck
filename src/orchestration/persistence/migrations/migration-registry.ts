/** Central migration registry. Every migration is registered here with its SQL and checksum. */

import type { Database } from "bun:sqlite"
import { computeChecksum } from "./migration-checksum"
import { SCHEMA_V_0_2_6 } from "./schema-embed"
import { MIGRATION_V2_REPLAY_SQL } from "./migration-v2-replay"
import { MIGRATION_V3_EXECUTION_SQL } from "./migration-v3-execution"
import { MIGRATION_V4_PERFORMANCE_SQL } from "./migration-v4-performance"
import { MIGRATION_V5_EXECUTION_CONSTRAINTS_SQL } from "./migration-v5-execution-constraints"
import { MIGRATION_V6_COMMANDS_SQL } from "./migration-v6-commands"
import { MIGRATION_V7_ASSIGNMENT_BINDING_SQL } from "./migration-v7-assignment-binding"
import { MIGRATION_V8_HEIDI_PERSISTENT_AGENT_SQL } from "./migration-v8-heidi-persistent-agent"
import { MIGRATION_V9_HEIDI_LEARNING_RUNTIME_SQL } from "./migration-v9-heidi-learning-runtime"
import { MIGRATION_V10_HEIDI_RUNTIME_CLOSURE_SQL } from "./migration-v10-heidi-runtime-closure"
import { MIGRATION_V11_HEIDI_PARALLEL_ENGINE_SQL } from "./migration-v11-heidi-parallel-engine"
import { MIGRATION_V12_ORCHESTRATION_RUNTIME_INTEGRITY_SQL } from "./migration-v12-orchestration-runtime-integrity"
import {
  MIGRATION_V13_CONVERGENCE_INTEGRITY_SQL,
  MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE,
  applyV13Migration,
} from "./migration-v13-convergence-integrity"

export interface MigrationEntry {
  version: number
  name: string
  sql: string
  checksum: string
  apply?: (db: Database) => void
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
  {
    version: 5,
    name: "execution_integrity_constraints_v0.2.10",
    sql: MIGRATION_V5_EXECUTION_CONSTRAINTS_SQL,
    checksum: computeChecksum(MIGRATION_V5_EXECUTION_CONSTRAINTS_SQL),
  },
  {
    version: 6,
    name: "canonical_command_invocations_v0.2.11",
    sql: MIGRATION_V6_COMMANDS_SQL,
    checksum: computeChecksum(MIGRATION_V6_COMMANDS_SQL),
  },
  {
    version: 7,
    name: "assignment_execution_binding_v0.2.12",
    sql: MIGRATION_V7_ASSIGNMENT_BINDING_SQL,
    checksum: computeChecksum(MIGRATION_V7_ASSIGNMENT_BINDING_SQL),
  },
  {
    version: 8,
    name: "heidi_persistent_agent_v2.0.0-alpha",
    sql: MIGRATION_V8_HEIDI_PERSISTENT_AGENT_SQL,
    checksum: computeChecksum(MIGRATION_V8_HEIDI_PERSISTENT_AGENT_SQL),
  },
  { version: 9, name: "heidi_learning_runtime_v2.0.0-alpha", sql: MIGRATION_V9_HEIDI_LEARNING_RUNTIME_SQL, checksum: computeChecksum(MIGRATION_V9_HEIDI_LEARNING_RUNTIME_SQL) },
  { version: 10, name: "heidi_runtime_closure_v2.0.0-alpha", sql: MIGRATION_V10_HEIDI_RUNTIME_CLOSURE_SQL, checksum: computeChecksum(MIGRATION_V10_HEIDI_RUNTIME_CLOSURE_SQL) },
  { version: 11, name: "heidi_parallel_engine_v2.0.0-alpha", sql: MIGRATION_V11_HEIDI_PARALLEL_ENGINE_SQL, checksum: computeChecksum(MIGRATION_V11_HEIDI_PARALLEL_ENGINE_SQL) },
  { version: 12, name: "orchestration_runtime_integrity_v2.0.0-alpha", sql: MIGRATION_V12_ORCHESTRATION_RUNTIME_INTEGRITY_SQL, checksum: computeChecksum(MIGRATION_V12_ORCHESTRATION_RUNTIME_INTEGRITY_SQL) },
  { version: 13, name: "convergence_integrity_v2.0.0-alpha", sql: MIGRATION_V13_CONVERGENCE_INTEGRITY_SQL, checksum: computeChecksum(MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE), apply: applyV13Migration },
]
