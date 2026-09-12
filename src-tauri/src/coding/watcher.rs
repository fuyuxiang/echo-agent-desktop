//! Cross-file workspace symbol index file watcher (phase 2).
//!
//! Glues `notify-debouncer-full` to `symbols::upsert_file` /
//! `symbols::remove_file` so any change in the workspace reconciles the
//! on-disk index within ~400ms without a full rebuild. Events are emitted
//! on the standard `coding://index-updated` and `coding://index-removed`
//! channels so the renderer keeps its cache in sync.
//!
//! Only events whose relative path is indexable (TS / JS / Rust / Python /
//! Go / Java) trigger an upsert; everything else is silently dropped.
//! Watcher handles are cheap to drop — they own a single OS-level watcher
//! and one drain thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::coding::symbols;
use crate::shell_fs::FilesystemAccess;

#[derive(Clone, Debug)]
enum Classified {
    Modify(PathBuf),
    Remove(PathBuf),
    Rename { from: PathBuf, to: PathBuf },
}

#[derive(Serialize, Clone)]
struct IndexUpdatedPayload {
    root: String,
    file: String,
    added: u32,
    updated: u32,
    removed: u32,
}

#[derive(Serialize, Clone)]
struct IndexRemovedPayload {
    root: String,
    file: String,
}

/// Sink for processed events. In production this re-emits the event on the
/// Tauri bus; tests pass a recording closure instead so they can observe
/// events without spinning up a Tauri runtime.
pub trait EventSink: Send + Sync + 'static {
    fn index_updated(&self, root: &str, file: &str, added: u32, updated: u32, removed: u32);
    fn index_removed(&self, root: &str, file: &str);
}

/// Default sink: forwards events to the Tauri event bus.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn index_updated(&self, root: &str, file: &str, added: u32, updated: u32, removed: u32) {
        let _ = self.app.emit(
            "coding://index-updated",
            IndexUpdatedPayload {
                root: root.to_string(),
                file: file.to_string(),
                added,
                updated,
                removed,
            },
        );
    }
    fn index_removed(&self, root: &str, file: &str) {
        let _ = self.app.emit(
            "coding://index-removed",
            IndexRemovedPayload {
                root: root.to_string(),
                file: file.to_string(),
            },
        );
    }
}

/// Owns a debounced watcher. Drop the handle to stop watching.
pub struct WatcherHandle {
    _debouncer: Option<
        notify_debouncer_full::Debouncer<
            notify_debouncer_full::notify::RecommendedWatcher,
            notify_debouncer_full::RecommendedCache,
        >,
    >,
    stop: Arc<AtomicBool>,
    _join: std::thread::JoinHandle<()>,
}

/// Process-wide owner for workspace watchers. Holding the handle is essential:
/// dropping it immediately after bootstrap silently disables indexing updates.
#[derive(Default)]
pub struct WatcherRegistry {
    watchers: Mutex<HashMap<PathBuf, WatcherHandle>>,
}

impl WatcherRegistry {
    fn ensure(&self, app: AppHandle, root: PathBuf) -> Result<(), String> {
        let canonical = root.canonicalize().unwrap_or(root);
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "符号索引监听器状态已损坏".to_string())?;
        if watchers.contains_key(&canonical) {
            return Ok(());
        }
        let handle = spawn_watcher(app, canonical.clone())?;
        watchers.insert(canonical, handle);
        Ok(())
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Drop the debouncer first so the channel closes; the drain thread
        // then exits cleanly.
        self._debouncer.take();
    }
}

/// Spawn a debounced watcher over `root`. Events are dispatched onto a
/// worker thread which calls into `symbols::upsert_file` /
/// `symbols::remove_file` and forwards results through `sink` so the
/// renderer can keep caches in sync.
///
/// Returns a handle to the watcher — dropping it stops the listener.
pub fn spawn_watcher_with_sink<S: EventSink>(
    root: PathBuf,
    sink: Arc<S>,
) -> Result<WatcherHandle, String> {
    use notify_debouncer_full::DebouncedEvent;

    if !root.is_dir() {
        return Err("工作区根目录不存在或不是目录".into());
    }
    // Canonicalize the root so events whose paths come back through macOS's
    // /private/var symlink (or any other normalization) still strip_prefix
    // successfully.
    let root = std::fs::canonicalize(&root).unwrap_or(root);

    let (tx, rx) = std::sync::mpsc::channel();
    // 400ms debounce: multiple saves in quick succession collapse into one.
    let mut debouncer =
        notify_debouncer_full::new_debouncer(std::time::Duration::from_millis(400), None, tx)
            .map_err(|error| format!("启动文件监听失败：{error}"))?;

    debouncer
        .watch(
            &root,
            notify_debouncer_full::notify::RecursiveMode::Recursive,
        )
        .map_err(|error| format!("挂载监听器失败：{error}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let handle = {
        let root = root.clone();
        let stop = stop.clone();
        std::thread::Builder::new()
            .name(format!("coding-watcher-{}", root.display()))
            .spawn(move || {
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let events: Vec<DebouncedEvent> =
                        match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                            Ok(result) => match result {
                                Ok(batch) => batch,
                                Err(errors) => {
                                    tracing::warn!(?errors, "coding watcher received error events");
                                    continue;
                                }
                            },
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        };
                    for event in events {
                        let Some(classified) = classify(&event) else {
                            continue;
                        };
                        let root = root.clone();
                        let sink = sink.clone();
                        // Apply on the drain thread directly. spawn_blocking
                        // would require a tokio runtime and the work is
                        // already blocking. The debouncer queue is serialised
                        // by the receiver, so two events for the same path
                        // are processed in arrival order.
                        handle_classified(&root, &sink, classified);
                    }
                }
            })
            .map_err(|error| format!("启动监听线程失败：{error}"))?
    };

    Ok(WatcherHandle {
        _debouncer: Some(debouncer),
        stop,
        _join: handle,
    })
}

/// Convenience wrapper that uses the production `TauriEventSink`.
pub fn spawn_watcher(app: AppHandle, root: PathBuf) -> Result<WatcherHandle, String> {
    spawn_watcher_with_sink(root, Arc::new(TauriEventSink::new(app)))
}

#[tauri::command]
pub async fn coding_index_bootstrap(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    registry: State<'_, WatcherRegistry>,
    root: String,
) -> Result<symbols::IndexStatus, String> {
    let root = access.require_workspace(&root)?;
    let reconcile_root = root.clone();
    let status = tokio::task::spawn_blocking(move || symbols::reconcile(&reconcile_root))
        .await
        .map_err(|error| format!("初始化符号索引失败：{error}"))??;
    registry.ensure(app, root)?;
    Ok(status)
}

fn handle_classified<S: EventSink>(root: &Path, sink: &Arc<S>, classified: Classified) {
    match classified {
        Classified::Rename { from, to } => {
            handle_classified(root, sink, Classified::Remove(from));
            handle_classified(root, sink, Classified::Modify(to));
        }
        Classified::Modify(path) => {
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            if should_ignore(root, &path) {
                return;
            }
            let rel = relativize(root, &path);
            if !is_indexable_file(&rel) {
                return;
            }
            // macOS FSEvents emits Modify(Metadata) + Modify(Data) before the
            // file actually disappears from disk. If the file is gone by the
            // time we try to read it, treat the event as a removal instead.
            if !path.exists() {
                match symbols::remove_file(root, &rel) {
                    Ok(()) => {
                        sink.index_removed(&root.to_string_lossy(), &rel);
                    }
                    Err(error) => {
                        tracing::warn!(%error, file = %path.display(), "coding watcher remove_file failed");
                    }
                }
                return;
            }
            match symbols::upsert_file(root, &rel) {
                Ok(new_symbols) => {
                    sink.index_updated(
                        &root.to_string_lossy(),
                        &rel,
                        new_symbols.len() as u32,
                        0,
                        0,
                    );
                }
                Err(error) => {
                    tracing::warn!(%error, file = %path.display(), "coding watcher upsert_file failed");
                }
            }
        }
        Classified::Remove(path) => {
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            if should_ignore(root, &path) {
                return;
            }
            let rel = relativize(root, &path);
            if !is_indexable_file(&rel) {
                return;
            }
            match symbols::remove_file(root, &rel) {
                Ok(()) => {
                    sink.index_removed(&root.to_string_lossy(), &rel);
                }
                Err(error) => {
                    tracing::warn!(%error, file = %path.display(), "coding watcher remove_file failed");
                }
            }
        }
    }
}

/// Build the set of top-level directory basenames we always ignore (in
/// addition to whatever `.gitignore` already excludes). Used as a fast
/// filter on every debounced event.
fn ignored_top_level_dirs() -> std::collections::BTreeSet<&'static str> {
    [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".venv",
        "__pycache__",
        "coverage",
        ".cache",
        ".idea",
        ".vscode",
    ]
    .iter()
    .copied()
    .collect()
}

/// Translate a `notify_debouncer_full` event into a logical operation.
/// Metadata-only modifications (mtime / permissions) are dropped — they
/// never change a file's parsed symbol set.
fn classify(event: &notify_debouncer_full::DebouncedEvent) -> Option<Classified> {
    use notify_debouncer_full::notify::event::{ModifyKind, RenameMode};
    use notify_debouncer_full::notify::EventKind;

    match &event.kind {
        EventKind::Create(_) => event.paths.first().cloned().map(Classified::Modify),
        EventKind::Modify(ModifyKind::Metadata(_)) | EventKind::Access(_) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            Some(Classified::Rename {
                from: event.paths[0].clone(),
                to: event.paths[1].clone(),
            })
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            event.paths.first().cloned().map(Classified::Remove)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            event.paths.first().cloned().map(Classified::Modify)
        }
        EventKind::Modify(_) => event.paths.first().cloned().map(Classified::Modify),
        EventKind::Remove(_) => event.paths.first().cloned().map(Classified::Remove),
        _ => None,
    }
}

/// Return true if the path lives under one of the always-ignored top-level
/// directories.
fn should_ignore(root: &Path, path: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => return true,
    };
    let ignored = ignored_top_level_dirs();
    for component in rel.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if ignored.contains(name.as_ref()) {
                return true;
            }
        }
    }
    false
}

/// Relative-path predicate: the watcher only triggers an upsert for files
/// whose extension the symbol index already recognises.
fn is_indexable_file(rel: &str) -> bool {
    let ext = std::path::Path::new(rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "rs" | "py" | "go" | "java"
    )
}

/// Relative POSIX-style path derived from an absolute `path` under `root`.
fn relativize(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-watcher-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn init_index(root: &Path) {
        let status = crate::coding::symbols::build_index(root).unwrap();
        assert_eq!(status.state, crate::coding::symbols::IndexState::Ready);
    }

    /// Recording sink that captures every forwarded event for assertions.
    #[derive(Default)]
    struct RecordingSink {
        updated: Mutex<Vec<(String, String, u32, u32, u32)>>,
        removed: Mutex<Vec<(String, String)>>,
    }

    impl EventSink for RecordingSink {
        fn index_updated(&self, root: &str, file: &str, added: u32, updated: u32, removed: u32) {
            self.updated.lock().unwrap().push((
                root.to_string(),
                file.to_string(),
                added,
                updated,
                removed,
            ));
        }
        fn index_removed(&self, root: &str, file: &str) {
            self.removed
                .lock()
                .unwrap()
                .push((root.to_string(), file.to_string()));
        }
    }

    #[test]
    fn spawn_watcher_returns_err_for_missing_root() {
        let missing = Path::new("/nonexistent-workspace-for-watcher-test");
        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        assert!(spawn_watcher_with_sink(missing.to_path_buf(), sink).is_err());
    }

    #[test]
    fn is_indexable_file_filters_by_extension() {
        assert!(is_indexable_file("src/auth.ts"));
        assert!(is_indexable_file("src/auth.tsx"));
        assert!(is_indexable_file("src/auth.rs"));
        assert!(is_indexable_file("src/auth.py"));
        assert!(is_indexable_file("src/auth.go"));
        assert!(is_indexable_file("src/auth.java"));
        assert!(!is_indexable_file("README.md"));
        assert!(!is_indexable_file("assets/logo.png"));
        assert!(!is_indexable_file("Makefile"));
    }

    #[test]
    fn should_ignore_filters_ignored_top_level_dirs() {
        let root = Path::new("/workspace");
        assert!(should_ignore(root, Path::new("/workspace/.git/config")));
        assert!(should_ignore(
            root,
            Path::new("/workspace/node_modules/pkg/index.js")
        ));
        assert!(should_ignore(
            root,
            Path::new("/workspace/target/debug/binary")
        ));
        assert!(!should_ignore(root, Path::new("/workspace/src/auth.ts")));
    }

    #[test]
    fn raw_notify_test_sanity_check() {
        // Sanity check: confirm notify itself delivers events on this OS.
        // If this test fails, the issue is not in our wiring but in the
        // notification stack (e.g. CI sandboxing).
        use std::sync::mpsc;
        let temp_root =
            std::env::temp_dir().join(format!("notify-sanity-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&temp_root).unwrap();
        fs::create_dir_all(temp_root.join("src")).unwrap();

        let (tx, rx) = mpsc::channel();
        let mut debouncer =
            notify_debouncer_full::new_debouncer(Duration::from_millis(50), None, tx).unwrap();
        debouncer
            .watch(
                &temp_root,
                notify_debouncer_full::notify::RecursiveMode::Recursive,
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(800));

        fs::write(
            temp_root.join("src/sanity.ts"),
            "export function sanity() {}\n",
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        let result = rx.recv_timeout(Duration::from_millis(500));
        drop(debouncer);
        fs::remove_dir_all(&temp_root).ok();
        assert!(
            result.is_ok(),
            "raw notify produced no events: {:?}",
            result
        );
    }

    #[test]
    fn watcher_round_trip_emits_updated_for_new_file() {
        let root = temp_root();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.ts"), "export function ready() {}\n").unwrap();
        init_index(&root);

        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        let handle = spawn_watcher_with_sink(root.clone(), sink.clone()).unwrap();

        // Give the debouncer time to start watching before we mutate.
        std::thread::sleep(Duration::from_millis(1000));
        fs::write(root.join("src/extra.ts"), "export function extra() {}\n").unwrap();
        std::thread::sleep(Duration::from_millis(3000));

        let symbols = crate::coding::symbols::load_index(&root);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        let recorded = sink.updated.lock().unwrap().clone();
        assert!(
            names.contains(&"extra"),
            "extra symbol missing (sink events: {recorded:?}, names: {names:?})"
        );
        drop(handle);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn watcher_modify_existing_file() {
        // Some platforms coalesce Create+Modify into a single Modify event;
        // verify the modify path is observed even for files that already
        // exist before the watcher starts.
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("existing.ts"), "export function before() {}\n").unwrap();
        init_index(&root);

        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        let handle = spawn_watcher_with_sink(root.clone(), sink.clone()).unwrap();

        std::thread::sleep(Duration::from_millis(1000));
        fs::write(root.join("existing.ts"), "export function after() {}\n").unwrap();
        std::thread::sleep(Duration::from_millis(3000));

        let symbols = crate::coding::symbols::load_index(&root);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        let recorded = sink.updated.lock().unwrap().clone();
        assert!(
            names.contains(&"after"),
            "after symbol missing (sink events: {recorded:?}, names: {names:?})"
        );
        drop(handle);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn watcher_removes_file_from_index() {
        let root = temp_root();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/only.ts"), "export function only() {}\n").unwrap();
        init_index(&root);

        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        let handle = spawn_watcher_with_sink(root.clone(), sink.clone()).unwrap();

        std::thread::sleep(Duration::from_millis(600));
        fs::remove_file(root.join("src/only.ts")).unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        let symbols = crate::coding::symbols::load_index(&root);
        assert!(
            !symbols.iter().any(|s| s.name == "only"),
            "removed symbol should no longer be in the index"
        );
        let recorded = sink.removed.lock().unwrap();
        assert!(
            !recorded.is_empty(),
            "sink should have at least one removal"
        );
        drop(handle);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn watcher_ignores_events_inside_ignored_dirs() {
        let root = temp_root();
        init_index(&root);
        fs::create_dir_all(root.join(".git/refs")).unwrap();

        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        let handle = spawn_watcher_with_sink(root.clone(), sink.clone()).unwrap();

        std::thread::sleep(Duration::from_millis(600));
        fs::create_dir_all(root.join(".git/hooks")).unwrap();
        fs::write(
            root.join(".git/hooks/hook.ts"),
            "export function nope() {}\n",
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        let symbols = crate::coding::symbols::load_index(&root);
        assert!(
            !symbols.iter().any(|s| s.name == "nope"),
            "symbol inside .git/ must not be indexed: {symbols:?}"
        );
        drop(handle);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn watcher_debounces_rapid_modifications() {
        let root = temp_root();
        fs::write(root.join("a.ts"), "export function a() {}\n").unwrap();
        init_index(&root);

        let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
        let handle = spawn_watcher_with_sink(root.clone(), sink.clone()).unwrap();

        std::thread::sleep(Duration::from_millis(600));
        for i in 0..3 {
            fs::write(
                root.join("a.ts"),
                format!("export function a() {{ return {i}; }}\n"),
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(1500));

        let symbols = crate::coding::symbols::load_index(&root);
        let count = symbols.iter().filter(|s| s.file == "a.ts").count();
        let recorded = sink.updated.lock().unwrap().clone();
        assert!(
            recorded.iter().any(|r| r.1 == "a.ts"),
            "debounce sink should record at least one event for a.ts, got: {recorded:?}"
        );
        assert_eq!(count, 1, "expected a single record for a.ts, got {count}");
        drop(handle);
        fs::remove_dir_all(&root).ok();
    }
}
