use thiserror::Error;

#[derive(Debug, Error)]
pub enum InvalidationError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
}

pub struct InvalidationEngine;

impl InvalidationEngine {
    pub fn invalidate_file(
        conn: &rusqlite::Connection,
        canonical_path: &str,
    ) -> Result<usize, InvalidationError> {
        let count = conn.execute(
            "UPDATE edges SET stale = 1 
             WHERE from_node IN (SELECT stable_id FROM nodes WHERE canonical_path = ?1)",
            rusqlite::params![canonical_path],
        )?;
        Ok(count)
    }

    pub fn invalidate_provider(
        conn: &rusqlite::Connection,
        provider: &str,
        fingerprint: &str,
    ) -> Result<usize, InvalidationError> {
        // If fingerprint changed, stale all edges from that provider
        let count = conn.execute(
            "UPDATE edges SET stale = 1 
             WHERE provider = ?1 AND provider_fingerprint != ?2",
            rusqlite::params![provider, fingerprint],
        )?;
        Ok(count)
    }

    pub fn delete_stale_edges(conn: &rusqlite::Connection) -> Result<usize, InvalidationError> {
        let count = conn.execute("DELETE FROM edges WHERE stale = 1", [])?;
        Ok(count)
    }

    pub fn delete_file(
        conn: &rusqlite::Connection,
        canonical_path: &str,
    ) -> Result<usize, InvalidationError> {
        // FK CASCADE will delete nodes and edges
        let count = conn.execute(
            "DELETE FROM files WHERE canonical_path = ?1",
            rusqlite::params![canonical_path],
        )?;
        Ok(count)
    }
}
