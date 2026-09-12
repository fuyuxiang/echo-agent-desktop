//! Coding Agent workbench backend: task persistence, orchestration,
//! verification, diagnostics and delivery. Kept separate from the legacy
//! `coding_workspace` module so the workbench owns its own state.

pub mod changeset;
pub mod delivery;
pub mod diagnostics;
pub mod impact;
pub mod orchestrator;
pub mod refs;
pub mod store;
pub mod symbols;
pub mod task;
pub mod verification;
pub mod watcher;
