//! Milestone 11 learned verification policy.
//!
//! M11 consumes only qualified M10 evidence and may widen an M6 plan through
//! `ADD_CHECK`; it has no authority to remove checks, upgrade assurance, or
//! erase unresolved obligations.

pub mod candidate;
pub mod identity;
pub mod model;
pub mod overlay;
pub mod promotion;
pub mod schema;

pub use candidate::*;
pub use identity::*;
pub use model::*;
pub use overlay::*;
pub use promotion::*;
