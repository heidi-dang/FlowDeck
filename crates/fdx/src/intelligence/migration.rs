use crate::intelligence::db::DatabaseError;
use rusqlite::Connection;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("Unsupported migration from v{0} to v{1}")]
    Unsupported(u32, u32),
}

impl From<MigrationError> for DatabaseError {
    fn from(err: MigrationError) -> Self {
        match err {
            MigrationError::Db(e) => DatabaseError::Sqlite(e),
            _ => DatabaseError::RecoveryFailed(err.to_string()),
        }
    }
}

pub fn migrate_schema(
    conn: &mut Connection,
    current_version: u32,
    target_version: u32,
) -> Result<(), MigrationError> {
    if current_version == target_version {
        return Ok(());
    }

    let tx = conn.transaction()?;

    let mut version = current_version;
    while version < target_version {
        match version {
            0 => {
                // Migrate v0 -> v1 (synthetic legacy schema to v1)
                tx.execute_batch(crate::intelligence::schema::INITIALIZE_SCHEMA_SQL)?;
            }
            1 => {
                // Migrate v1 -> v2: semantic provider ownership & provenance
                tx.execute_batch(crate::intelligence::schema::MIGRATE_V1_TO_V2_SQL)?;
            }
            2 => {
                // Migrate v2 -> v3: provider attempt diagnostics
                tx.execute_batch(crate::intelligence::schema::MIGRATE_V2_TO_V3_SQL)?;
            }
            3 => {
                // Migrate v3 -> v4: node derivation source_identity
                tx.execute_batch(crate::intelligence::schema::MIGRATE_V3_TO_V4_SQL)?;
            }
            4 => {
                // Migrate v4 -> v5: edge provider_id ownership
                tx.execute_batch(crate::intelligence::schema::MIGRATE_V4_TO_V5_SQL)?;
            }
            5 => {
                // Migrate v5 -> v6: Milestone 8 runtime verification history (immutable historical migration)
                tx.execute_batch(crate::intelligence::runtime::schema::MIGRATE_V5_TO_V6_SQL)?;
            }
            6 => {
                // Migrate v6 -> v7: Milestone 8 runtime verification history hardening (exact-byte digest, physical execution flag)
                tx.execute_batch(crate::intelligence::runtime::schema::MIGRATE_V6_TO_V7_SQL)?;
            }
            7 => {
                // Migrate v7 -> v8: Milestone 10 Shadow Calibration tables
                tx.execute_batch(crate::intelligence::calibration::schema::MIGRATE_V7_TO_V8_SQL)?;
            }
            _ => {
                return Err(MigrationError::Unsupported(version, target_version));
            }
        }
        version += 1;
        // The schema initialization sets user_version to 1 and inserts into schema_metadata.
        // We will make sure schema_metadata reflects the current migration step.
        tx.execute(
            "INSERT OR REPLACE INTO schema_metadata (version) VALUES (?1)",
            rusqlite::params![version],
        )?;
        tx.pragma_update(None, "user_version", version)?;
    }

    tx.commit()?;
    Ok(())
}
