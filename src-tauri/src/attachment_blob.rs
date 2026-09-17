//! Persistent storage for clipboard / drag-drop image blobs.
//!
//! Pasted or dragged images never carry a real local file path. We land them
//! in `<app_data_dir>/clipboard-images/<timestamp>-<rand>.<ext>` and hand the
//! resulting absolute path back to the frontend, so the existing
//! `attachments: string[]` pipeline (multimodal send, thumbnail render, ACP
//! metadata) keeps working without special-casing the origin.
//!
//! Filenames are always suffixed with a monotonic timestamp + 6 hex chars of
//! randomness so concurrent pastes (and 1-second clock drift) never collide.
//! Mime-to-extension mapping is deliberately identical to the formats the
//! multimodal pipeline accepts.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Build a safe base filename from the suggested name. Strips path
/// separators, drops empty / dot-only / whitespace-only results, and trims to
/// 80 chars so we never collide with the filesystem's name limit.
fn sanitize_basename(suggested: Option<&str>) -> Option<String> {
    let raw = suggested?.trim();
    if raw.is_empty() {
        return None;
    }
    // Strip directory components first so traversal attempts and absolute
    // paths collapse to their basename segment ("../../../etc/passwd" →
    // "passwd", "C:\\tmp\\foo.png" → "foo.png").
    let last_sep = raw.rfind(['/', '\\']).map(|index| index + 1).unwrap_or(0);
    let tail = &raw[last_sep..];
    // Then sanitize remaining OS-unsafe characters inside the basename.
    let cleaned: String = tail
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed: String = cleaned
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.chars().count() > 80 {
        trimmed.chars().take(80).collect()
    } else {
        trimmed
    })
}

/// Monotonic + 6-hex-char suffix; combines nanos + epoch nanos fallback to
/// stay unique even within the same nanosecond under contention.
fn unique_suffix() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = now.as_nanos();
    // Cheap pseudo-random tail; we don't need cryptographic strength, only
    // collision avoidance for concurrent paste events in the same nanosecond.
    let pid = std::process::id();
    let rand = pid.rotate_left(7) ^ nanos as u32 ^ (nanos >> 32) as u32;
    format!("{:013}-{:06x}", nanos, rand & 0xFF_FFFF)
}

/// Compose the destination path. The caller is responsible for creating
/// `dir` if it does not already exist (we keep this function pure for tests).
pub(crate) fn build_destination(
    dir: &Path,
    mime: &str,
    suggested_name: Option<&str>,
) -> Result<PathBuf, String> {
    let ext = extension_for_mime(mime).ok_or_else(|| format!("不支持的图片类型：{mime}"))?;
    let stem = sanitize_basename(suggested_name).unwrap_or_else(|| "image".to_string());
    let file_name = format!("{}-{}.{}", stem, unique_suffix(), ext);
    Ok(dir.join(file_name))
}

/// Write bytes to a fresh file inside `dir` using the private-file helper so
/// permissions stay owner-only on unix. Returns the absolute path.
pub fn save_blob(
    dir: &Path,
    bytes: &[u8],
    mime: &str,
    suggested_name: Option<&str>,
) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("粘贴的图片为空".into());
    }
    if bytes.len() as u64 > crate::shell_fs::MAX_ATTACHMENT_FILE_BYTES {
        return Err(format!(
            "单张图片不能超过 {}MB",
            crate::shell_fs::MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024
        ));
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("创建附件目录 {} 失败：{error}", dir.display()))?;
    let destination = build_destination(dir, mime, suggested_name)?;
    crate::paths::write_private_file(&destination, bytes)?;
    // write_private_file uses a staging file inside the same dir; the
    // canonicalize-to-staging dance is irrelevant to the caller.
    std::fs::canonicalize(&destination).map_err(|error| format!("解析附件路径失败：{error}"))
}

#[tauri::command]
pub async fn save_attachment_blob(
    app: tauri::AppHandle,
    access: tauri::State<'_, crate::shell_fs::FilesystemAccess>,
    bytes: Vec<u8>,
    mime: String,
    suggested_name: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("解析应用数据目录失败：{error}"))?
        .join("clipboard-images");
    let path = save_blob(&dir, &bytes, &mime, suggested_name.as_deref())?;
    if let Err(error) = access.authorize_file(&path) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn discard_attachment_blob(
    app: tauri::AppHandle,
    access: tauri::State<'_, crate::shell_fs::FilesystemAccess>,
    path: String,
) -> Result<(), String> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("解析应用数据目录失败：{error}"))?
        .join("clipboard-images");
    let raw = PathBuf::from(path);
    let Ok(metadata) = std::fs::symlink_metadata(&raw) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(());
    }
    let Ok(canonical_dir) = std::fs::canonicalize(&dir) else {
        return Ok(());
    };
    let Ok(canonical) = std::fs::canonicalize(&raw) else {
        return Ok(());
    };
    if canonical.parent() != Some(canonical_dir.as_path()) {
        return Ok(());
    }
    std::fs::remove_file(&canonical).map_err(|error| format!("删除未发送附件失败：{error}"))?;
    access.revoke_authorized_file(&canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_read(path: &Path) -> Vec<u8> {
        std::fs::read(path).expect("read back saved blob")
    }

    #[test]
    fn writes_bytes_to_disk_and_returns_absolute_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let bytes = b"\x89PNG\r\n\x1a\nfake-image-bytes";

        let path = save_blob(temp.path(), bytes, "image/png", None).expect("save");
        assert!(path.is_absolute(), "saved path must be absolute: {path:?}");
        assert_eq!(write_read(&path), bytes);
    }

    #[test]
    fn extension_follows_mime_mapping_for_known_image_types() {
        let temp = tempfile::tempdir().expect("temp dir");
        let png = save_blob(temp.path(), b"x", "image/png", None).unwrap();
        assert_eq!(png.extension().and_then(|v| v.to_str()), Some("png"));
        let jpeg = save_blob(temp.path(), b"x", "image/jpeg", None).unwrap();
        assert_eq!(jpeg.extension().and_then(|v| v.to_str()), Some("jpg"));
        let gif = save_blob(temp.path(), b"x", "image/gif", None).unwrap();
        assert_eq!(gif.extension().and_then(|v| v.to_str()), Some("gif"));
        let webp = save_blob(temp.path(), b"x", "image/webp", None).unwrap();
        assert_eq!(webp.extension().and_then(|v| v.to_str()), Some("webp"));
    }

    #[test]
    fn unknown_image_mime_is_rejected() {
        let temp = tempfile::tempdir().expect("temp dir");
        let error = save_blob(temp.path(), b"x", "image/avif", None).unwrap_err();
        assert!(error.contains("不支持的图片类型"));
    }

    #[test]
    fn mime_is_case_insensitive() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = save_blob(temp.path(), b"x", "IMAGE/PNG", None).unwrap();
        assert_eq!(path.extension().and_then(|v| v.to_str()), Some("png"));
    }

    #[test]
    fn suggested_name_is_used_as_stem_when_safe() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = save_blob(temp.path(), b"x", "image/png", Some("screenshot")).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(file_name.starts_with("screenshot-"), "got {file_name}");
        assert!(file_name.ends_with(".png"), "got {file_name}");
    }

    #[test]
    fn suggested_name_strips_path_separators_and_traversal() {
        let temp = tempfile::tempdir().expect("temp dir");
        // 路径穿越和绝对路径都只应留下 basename 段。
        let evil = "../../../etc/passwd";
        let path = save_blob(temp.path(), b"x", "image/png", Some(evil)).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(file_name.starts_with("passwd-"), "got {file_name}");
        // 必须仍在 temp 目录内(不能逃逸)。
        assert!(
            path.starts_with(temp.path().canonicalize().unwrap()),
            "{path:?}"
        );
    }

    #[test]
    fn suggested_name_sanitizes_os_unsafe_characters() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = save_blob(temp.path(), b"x", "image/png", Some("a:b*c?d\"e<f>g|h")).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let stem = file_name.split('-').next().unwrap();
        assert_eq!(stem, "a_b_c_d_e_f_g_h", "got {file_name}");
    }

    #[test]
    fn empty_or_whitespace_suggested_name_falls_back_to_image() {
        let temp = tempfile::tempdir().expect("temp dir");
        for bad in [None, Some(""), Some("   "), Some("....."), Some("\t\n")] {
            let path = save_blob(temp.path(), b"x", "image/png", bad).unwrap();
            let file_name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(
                file_name.starts_with("image-"),
                "got {file_name} for {bad:?}"
            );
        }
    }

    #[test]
    fn two_concurrent_saves_get_distinct_filenames() {
        let temp = tempfile::tempdir().expect("temp dir");
        let a = save_blob(temp.path(), b"abc", "image/png", None).unwrap();
        let b = save_blob(temp.path(), b"abc", "image/png", None).unwrap();
        assert_ne!(a, b, "concurrent saves must not collide");
        assert_eq!(write_read(&a), b"abc");
        assert_eq!(write_read(&b), b"abc");
    }

    #[test]
    fn empty_bytes_is_rejected_before_disk_write() {
        let temp = tempfile::tempdir().expect("temp dir");
        let error = save_blob(temp.path(), b"", "image/png", None).expect_err("empty blob");
        assert!(error.contains("空"), "got {error}");
        assert_eq!(
            std::fs::read_dir(temp.path()).unwrap().count(),
            0,
            "no file should be created on rejection"
        );
    }

    #[test]
    fn oversized_blob_is_rejected_before_disk_write() {
        let temp = tempfile::tempdir().expect("temp dir");
        let destination = temp.path().join("clipboard-images");
        let bytes = vec![0; crate::shell_fs::MAX_ATTACHMENT_FILE_BYTES as usize + 1];

        let error = save_blob(&destination, &bytes, "image/png", None)
            .expect_err("oversized blob must be rejected");

        assert!(error.contains("20MB"), "got {error}");
        assert!(
            !destination.exists(),
            "rejected blob must not create its destination directory"
        );
    }

    #[test]
    fn creates_directory_when_missing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let nested = temp.path().join("does/not/exist/yet");
        let path = save_blob(&nested, b"x", "image/png", None).unwrap();
        assert!(path.exists());
        assert_eq!(write_read(&path), b"x");
    }

    #[test]
    fn long_suggested_name_is_truncated_to_80_chars() {
        let temp = tempfile::tempdir().expect("temp dir");
        let long = "a".repeat(500);
        let path = save_blob(temp.path(), b"x", "image/png", Some(&long)).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        // stem 截断到 80 字符 + `-<suffix>.png`，整段文件名前缀 < 200。
        assert!(
            file_name.len() < 200,
            "got len {}: {file_name}",
            file_name.len()
        );
        let stem = file_name.split('-').next().unwrap();
        assert_eq!(
            stem.len(),
            80,
            "stem must be exactly 80 chars, got {}",
            stem.len()
        );
    }
}
