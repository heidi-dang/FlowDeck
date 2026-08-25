//! Milestone 9: Verification Attestation.
//!
//! Implements local-first in-toto Statement v1 verification attestations
//! binding exact M7 run artifacts and qualified M8 runtime observations.

pub mod build;
pub mod canonical;
pub mod model;
pub mod persist;
pub mod query;
pub mod v2;
pub mod verify;

pub use build::{
    build_verification_attestation, query_global_history_completeness, validate_run_id,
};
pub use canonical::{
    canonicalize_to_string, canonicalize_to_vec, compute_canonical_sha256, MAX_SAFE_INTEGER,
};
pub use model::{
    AttestationGenerator, AttestedCheck, AttestedExecution, AttestedPlan, AttestedRunIdentity,
    AttestedUncertainty, AttestedUnresolvedObligation, AttestedVerificationResult, InTotoDigest,
    InTotoStatement, InTotoSubject, RuntimeHistoryQualification, SourceContext,
    VerificationAttestation, VerificationPredicateV1, FDX_ATTESTATION_PREDICATE_VERSION,
    FDX_VERIFICATION_PREDICATE_V1_TYPE, IN_TOTO_STATEMENT_V1_TYPE,
};
pub use persist::{
    attestation_file_path, attestations_dir, classify_attestation_source,
    load_attestation_document_from_path, load_attestation_from_path, persist_attestation,
    persist_attestation_v2, AttestationDocument, AttestationSource, LoadedAttestation,
    ManagedAttestationDir, MAX_ATTESTATION_ARTIFACT_BYTES,
};
pub use query::{list_attestations, AttestationSummary};
pub use v2::{
    build_verification_attestation_v2, verify_attestation_v2, AppliedPolicyV2,
    PolicyApplicationContextV2, VerificationAttestationV2, VerificationPredicateV2,
    FDX_ATTESTATION_PREDICATE_V2_VERSION, FDX_VERIFICATION_PREDICATE_V2_TYPE,
};
pub use verify::{verify_attestation, AttestationVerificationReport};
