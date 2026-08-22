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
        // Structural edges are marked stale; semantic provider edges are
        // governed by provider freshness and are replaced transactionally by
        // a provider refresh, never cascade-deleted by a file reindex.
        let count = conn.execute(
            "UPDATE edges SET stale = 1 
             WHERE from_node IN (SELECT stable_id FROM nodes WHERE canonical_path = ?1)
               AND provider != 'scip'",
            rusqlite::params![canonical_path],
        )?;
        // Provider-owned nodes for this source version become stale so the
        // query path never presents them as current evidence.
        conn.execute(
            "UPDATE nodes SET stale = 1
             WHERE canonical_path = ?1 AND provider IS NOT NULL",
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
