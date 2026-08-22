use crate::intelligence::db::{DatabaseError, EvidenceDatabase};
use crate::protocol::GraphCompatibility;

#[derive(Debug, PartialEq, Eq)]
pub enum CompatibilityStatus {
    Compatible,
    MigrationRequired(u32, u32), // from, to
    ProviderRefreshRequired,
    SemanticRebuildRequired,
    FutureSchema,
    Incompatible,
}

pub fn check_compatibility(
    db: &EvidenceDatabase,
    current: &GraphCompatibility,
) -> Result<CompatibilityStatus, DatabaseError> {
    let schema_ver: u32 = db.get_schema_version().map(|v| v.version).unwrap_or(0);

    if schema_ver > current.graph_schema_version {
        return Ok(CompatibilityStatus::FutureSchema);
    } else if schema_ver < current.graph_schema_version {
        return Ok(CompatibilityStatus::MigrationRequired(
            schema_ver,
            current.graph_schema_version,
        ));
    }

    let semantic_ver = db
        .get_metadata("semantic_model_version")?
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    if semantic_ver != current.semantic_model_version {
        return Ok(CompatibilityStatus::SemanticRebuildRequired);
    }

    let provider_fp = db.get_metadata("provider_fingerprint")?.unwrap_or_default();
    if provider_fp != current.provider_fingerprint {
        return Ok(CompatibilityStatus::ProviderRefreshRequired);
    }

    Ok(CompatibilityStatus::Compatible)
}

pub fn persist_compatibility(
    tx: &crate::intelligence::index::TransactionalGraph,
    current: &GraphCompatibility,
) -> Result<(), crate::intelligence::index::IndexError> {
    tx.set_metadata(
        "semantic_model_version",
        &current.semantic_model_version.to_string(),
    )?;
    tx.set_metadata(
        "selection_policy_version",
        &current.selection_policy_version.to_string(),
    )?;
    tx.set_metadata("provider_fingerprint", &current.provider_fingerprint)?;
    tx.set_metadata(
        "build_adapter_fingerprint",
        &current.build_adapter_fingerprint,
    )?;
    Ok(())
}
