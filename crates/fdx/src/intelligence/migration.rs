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
