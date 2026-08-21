use crate::intelligence::schema::{CURRENT_SCHEMA_VERSION, INITIALIZE_SCHEMA_SQL};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Unsupported future schema version: {0}")]
    FutureSchemaVersion(u32),
    #[error("Corruption recovery failed: {0}")]
    RecoveryFailed(String),
}

pub struct EvidenceDatabase {
    pub conn: Connection,
    #[allow(dead_code)]
    repo_root: PathBuf,
}

impl EvidenceDatabase {
    pub fn open(repo_root: &Path) -> Result<Self, DatabaseError> {
        let fdx_dir = repo_root.join(".fdx");
        if !fdx_dir.exists() {
            std::fs::create_dir_all(&fdx_dir)?;
        }

        let db_path = fdx_dir.join("index.sqlite");

        let conn = match Self::try_open_and_validate(&db_path) {
            Ok(c) => c,
            Err(DatabaseError::Sqlite(_e)) => {
                // If corrupted, try recovery
                Self::quarantine_corrupt(&db_path)?;
                Self::try_open_and_validate(&db_path)?
            }
            Err(e) => return Err(e),
        };

        Ok(EvidenceDatabase {
            conn,
            repo_root: repo_root.to_path_buf(),
        })
    }

    fn try_open_and_validate(db_path: &Path) -> Result<Connection, DatabaseError> {
        let conn = Connection::open(db_path)?;

        // Simple pragma check to ensure it's a valid database
        conn.pragma_query(None, "schema_version", |_| Ok(()))?;

        // Initialize or validate schema
        let user_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if user_version == 0 {
            // New database
            conn.execute_batch(INITIALIZE_SCHEMA_SQL)?;
        } else if user_version > CURRENT_SCHEMA_VERSION {
            return Err(DatabaseError::FutureSchemaVersion(user_version));
        } else {
            // Validate schema_metadata exists if user_version > 0
            let meta_version: Result<u32, _> =
                conn.query_row("SELECT version FROM schema_metadata", [], |row| row.get(0));
            match meta_version {
                Ok(v) if v > CURRENT_SCHEMA_VERSION => {
                    return Err(DatabaseError::FutureSchemaVersion(v))
                }
                Ok(_) => {}
                Err(_) => {
                    // It might be an empty db that somehow has user_version set, or corrupt metadata.
                    return Err(DatabaseError::Sqlite(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                        Some("Missing schema_metadata table".to_string()),
                    )));
                }
            }
        }

        // Enable WAL if supported
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;

        Ok(conn)
    }

    fn quarantine_corrupt(db_path: &Path) -> Result<(), DatabaseError> {
        if db_path.exists() {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let parent = db_path.parent().unwrap();
            let new_name = format!("index.corrupt.{}.sqlite", timestamp);
            std::fs::rename(db_path, parent.join(new_name))?;
        }
        Ok(())
    }

    pub fn get_schema_version(
        &self,
    ) -> Result<crate::intelligence::schema::SchemaVersion, DatabaseError> {
        let version: u32 =
            self.conn
                .query_row("SELECT version FROM schema_metadata", [], |row| row.get(0))?;
        Ok(crate::intelligence::schema::SchemaVersion { version })
    }
}
