//! Real sqlite-vec integration through the desktop's vendored memory API.
//! All source files, SQLite databases and memory roots belong to a TempDir.
use echo_agent_memory::{
    index::{init_sqlite_vec, MemoryIndex},
    storage::MemoryStorage,
};
use tempfile::TempDir;

fn index(temp: &TempDir) -> MemoryIndex {
    init_sqlite_vec();
    let root = temp.path().join("memory");
    let storage = MemoryStorage::new_flat(temp.path(), &root);
    let index = MemoryIndex::open_or_create(
        &temp.path().join("index.sqlite"),
        storage,
        Default::default(),
        4,
    )
    .unwrap();
    assert!(
        index.vec_available(),
        "The desktop's real sqlite-vec must be available"
    );
    index
}

#[test]
fn repeated_embedding_replaces_the_real_vector_and_survives_reopen() {
    let temp = TempDir::new().unwrap();
    let mut current = index(&temp);
    let source = temp.path().join("中文记忆.md");
    std::fs::write(&source, "# 隔离记忆\n\n重复索引必须更新向量。\n").unwrap();
    current.reindex_file(&source, "workspace").unwrap();
    let chunk = format!("{}:0", source.to_string_lossy());
    current
        .upsert_embedding(&chunk, &[1.0, 0.0, 0.0, 0.0])
        .unwrap();
    for _ in 0..3 {
        current
            .upsert_embedding(&chunk, &[0.0, 1.0, 0.0, 0.0])
            .unwrap();
    }
    let hits = current.vector_search(&[0.0, 1.0, 0.0, 0.0], 4).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, chunk);
    assert!(
        hits[0].1.abs() < 0.0001,
        "Search still used the previous embedding"
    );
    assert!(current.chunks_without_embeddings().unwrap().is_empty());
    drop(current);
    let reopened = index(&temp);
    let hits = reopened.vector_search(&[0.0, 1.0, 0.0, 0.0], 4).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, chunk);
    assert!(hits[0].1.abs() < 0.0001);
}

#[test]
fn invalid_replacement_keeps_the_previous_searchable_vector() {
    let temp = TempDir::new().unwrap();
    let mut current = index(&temp);
    let source = temp.path().join("source.md");
    std::fs::write(
        &source,
        "# Isolated knowledge\n\nValid embedding stays available.\n",
    )
    .unwrap();
    current.reindex_file(&source, "workspace").unwrap();
    let chunk = format!("{}:0", source.to_string_lossy());
    let valid = [0.0, 1.0, 0.0, 0.0];
    current.upsert_embedding(&chunk, &valid).unwrap();
    assert!(current.upsert_embedding(&chunk, &[1.0, 2.0]).is_err());
    assert!(current
        .upsert_embedding(&chunk, &[f32::NAN, 0.0, 0.0, 0.0])
        .is_err());
    let hits = current.vector_search(&valid, 4).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, chunk);
    assert!(hits[0].1.abs() < 0.0001);
}
