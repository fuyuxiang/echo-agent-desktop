//! Coding Agent workbench backend: task persistence, orchestration,
//! verification, diagnostics and delivery. Kept separate from the legacy
//! `coding_workspace` module so the workbench owns its own state.

pub mod store;
