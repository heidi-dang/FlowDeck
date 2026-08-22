use crate::intelligence::schema::CURRENT_SCHEMA_VERSION;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DatabaseOpenMode {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Unsupported future schema version: {0}")]
    FutureSchemaVersion(u32),
    #[error("Database is corrupt")]
    Corrupt,
    #[error("Database is busy or locked")]
    Busy,
    #[error("Not indexed (database absent)")]
    NotIndexed,
    #[error("Corruption recovery failed: {0}")]
    RecoveryFailed(String),
}

pub struct EvidenceDatabase {
    pub conn: Connection,
    #[allow(dead_code)]
    repo_root: PathBuf,
}

impl EvidenceDatabase {
    pub fn open(repo_root: &Path, mode: DatabaseOpenMode) -> Result<Self, DatabaseError> {
        let fdx_dir = repo_root.join(".fdx");
        let db_path = fdx_dir.join("index.sqlite");

        if mode == DatabaseOpenMode::ReadOnly && !db_path.exists() {
            return Err(DatabaseError::NotIndexed);
        }

        if mode == DatabaseOpenMode::ReadWrite && !fdx_dir.exists() {
            std::fs::create_dir_all(&fdx_dir)?;
        }

        let conn = match Self::try_open_and_validate(&db_path, mode) {
            Ok(c) => c,
            Err(e) => {
                // If corrupted and we have write access, try recovery
                if mode == DatabaseOpenMode::ReadWrite && matches!(e, DatabaseError::Corrupt) {
                    Self::quarantine_corrupt(&db_path)?;
                    Self::try_open_and_validate(&db_path, mode)?
                } else {
                    return Err(e);
                }
            }
        };

        Ok(EvidenceDatabase {
            conn,
            repo_root: repo_root.to_path_buf(),
        })
    }

    fn try_open_and_validate(
        db_path: &Path,
        mode: DatabaseOpenMode,
    ) -> Result<Connection, DatabaseError> {
        let flags = if mode == DatabaseOpenMode::ReadOnly {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
        };

        let mut conn = match Connection::open_with_flags(db_path, flags) {
            Ok(c) => c,
            Err(e) => return Err(Self::classify_sqlite_error(e)),
        };

        // Enable foreign keys
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(Self::classify_sqlite_error)?;

        // Simple pragma check to ensure it's a valid database
        if let Err(e) = conn.pragma_query(None, "schema_version", |_| Ok(())) {
            return Err(Self::classify_sqlite_error(e));
        }

        // Initialize or validate schema
        let user_version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(Self::classify_sqlite_error)?;

        if user_version == 0 {
            if mode == DatabaseOpenMode::ReadOnly {
                return Err(DatabaseError::NotIndexed);
            }
            // New database handled by migration from 0
            crate::intelligence::migration::migrate_schema(&mut conn, 0, CURRENT_SCHEMA_VERSION)?;
        } else if user_version > CURRENT_SCHEMA_VERSION {
            return Err(DatabaseError::FutureSchemaVersion(user_version));
        } else if user_version < CURRENT_SCHEMA_VERSION {
            if mode == DatabaseOpenMode::ReadOnly {
                // Must be migrated first
                // However, read-only mode can't migrate.
                // Status evaluation might need to report this.
                // But for opening, we just let it open and the user must refresh/migrate via ReadWrite.
            } else {
                crate::intelligence::migration::migrate_schema(
                    &mut conn,
                    user_version,
                    CURRENT_SCHEMA_VERSION,
                )?;
            }
        } else {
            // Validating schema_metadata
            let meta_version: Result<u32, _> =
                conn.query_row("SELECT MAX(version) FROM schema_metadata", [], |row| {
                    row.get(0)
                });
            match meta_version {
                Ok(v) if v > CURRENT_SCHEMA_VERSION => {
                    return Err(DatabaseError::FutureSchemaVersion(v))
                }
                Ok(_) => {}
                Err(_) => {
                    return Err(DatabaseError::Corrupt);
                }
            }
        }

        if mode == DatabaseOpenMode::ReadWrite {
            // Try to enable WAL, but don't fail if it doesn't work (e.g. unsupported filesystem)
            let _ = conn.pragma_update(None, "journal_mode", "WAL");
            let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        }

        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(Self::classify_sqlite_error)?;

        Ok(conn)
    }

    fn classify_sqlite_error(err: rusqlite::Error) -> DatabaseError {
        match &err {
            rusqlite::Error::SqliteFailure(ffi_err, _) => match ffi_err.code {
                rusqlite::ffi::ErrorCode::DatabaseCorrupt
                | rusqlite::ffi::ErrorCode::NotADatabase => DatabaseError::Corrupt,
                rusqlite::ffi::ErrorCode::DatabaseBusy
                | rusqlite::ffi::ErrorCode::DatabaseLocked => DatabaseError::Busy,
                _ => DatabaseError::Sqlite(err),
            },
            _ => DatabaseError::Sqlite(err),
        }
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

            // Clean sidecars
            let wal = db_path.with_file_name("index.sqlite-wal");
            if wal.exists() {
                let _ = std::fs::rename(
                    wal,
                    parent.join(format!("index.corrupt.{}.sqlite-wal", timestamp)),
                );
            }
            let shm = db_path.with_file_name("index.sqlite-shm");
            if shm.exists() {
                let _ = std::fs::rename(
                    shm,
                    parent.join(format!("index.corrupt.{}.sqlite-shm", timestamp)),
                );
            }
        }
        Ok(())
    }

    pub fn get_metadata(&self, key: &str) -> Result<Option<String>, DatabaseError> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM metadata WHERE key = ?1")?;
        let mut rows = stmt.query(rusqlite::params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_schema_version(
        &self,
    ) -> Result<crate::intelligence::schema::SchemaVersion, DatabaseError> {
        // MAX: the table accumulates one row per applied migration step; the
        // effective version is the highest applied step.
        let version: u32 = self
            .conn
            .query_row("SELECT MAX(version) FROM schema_metadata", [], |row| row.get(0))?;
        Ok(crate::intelligence::schema::SchemaVersion { version })
    }
}
