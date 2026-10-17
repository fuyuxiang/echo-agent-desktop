//! Bounded avatar previews for experts already bound to saved conversations.
use std::path::{Path, PathBuf};

const MAX_EXPERT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXPERT_THUMB_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EXPERT_IMAGE_DIMENSION: u32 = 20_000;
const MAX_EXPERT_IMAGE_ALLOC: u64 = 160 * 1024 * 1024;

fn read_bounded_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取{label}信息失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label}必须是普通文件，不能是符号链接"));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label}超过 {} MB 安全上限",
            max_bytes / 1024 / 1024
        ));
    }
    crate::shell_fs::read_regular_file_bounded(path, max_bytes)
        .map_err(|error| format!("读取{label}失败：{error}"))
}

const THUMB_SIZE: u32 = 96;
const THUMB_QUALITY: u8 = 82;

fn thumb_cache_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("expert-thumbs")
}

/// A stable cache filename derived from the source path + mtime (so editing the
/// source regenerates the thumb).
fn thumb_path_for(src: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    src.to_string_lossy().as_ref().hash(&mut h);
    let mtime = std::fs::metadata(src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    mtime.hash(&mut h);
    let name = format!("{:016x}.jpg", h.finish());
    thumb_cache_dir().join(name)
}

async fn make_thumbnail(src: &Path) -> Result<String, String> {
    let source_metadata =
        std::fs::symlink_metadata(src).map_err(|error| format!("读取头像信息失败：{error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("头像必须是普通文件".into());
    }
    if source_metadata.len() > MAX_EXPERT_IMAGE_BYTES {
        return Err("头像超过 20 MB 安全上限".into());
    }
    let cache = thumb_path_for(src);
    if std::fs::symlink_metadata(&cache).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink()
            && metadata.is_file()
            && metadata.len() > 0
            && metadata.len() <= MAX_EXPERT_THUMB_BYTES
    }) {
        let bytes = read_bounded_file(&cache, MAX_EXPERT_THUMB_BYTES, "头像缓存")?;
        return Ok(b64(&bytes));
    }
    // Decode + resize off the async runtime (image work is CPU-bound).
    let source_bytes = read_bounded_file(src, MAX_EXPERT_IMAGE_BYTES, "头像")?;
    let jpeg = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use image::imageops::FilterType;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(source_bytes))
            .with_guessed_format()
            .map_err(|e| format!("识别图片格式失败：{e}"))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_EXPERT_IMAGE_DIMENSION);
        limits.max_image_height = Some(MAX_EXPERT_IMAGE_DIMENSION);
        limits.max_alloc = Some(MAX_EXPERT_IMAGE_ALLOC);
        reader.limits(limits);
        let img = reader.decode().map_err(|e| format!("解码图片失败：{e}"))?;
        let thumb = img.resize(THUMB_SIZE, THUMB_SIZE, FilterType::Triangle);
        let rgb = thumb.into_rgb8();
        let (w, h) = (rgb.width(), rgb.height());
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, THUMB_QUALITY);
        enc.encode(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
            .map_err(|e| format!("编码 JPEG 失败：{e}"))?;
        Ok(buf)
    })
    .await
    .map_err(|e| format!("缩略图任务失败：{e}"))??;

    // Cache write is best-effort; a failure still returns the image.
    let _ = crate::paths::write_private_file(&cache, &jpeg);
    Ok(b64(&jpeg))
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn authorize_avatar(path: &str, state: &crate::meta::EchoAgentState) -> Result<PathBuf, String> {
    if path.len() > 4_096 || !Path::new(path).is_absolute() {
        return Err("专家头像路径无效".into());
    }
    if !state
        .expert_sessions
        .values()
        .any(|expert| expert.avatar_local.as_deref() == Some(path))
    {
        return Err("头像未关联到已保存的专家会话".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("头像必须是普通文件".into());
    }
    Path::new(path)
        .canonicalize()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn expert_avatar(path: String) -> Result<String, String> {
    let src = authorize_avatar(&path, &crate::meta::read_state())?;
    make_thumbnail(&src).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_saved_expert_avatars_are_authorized() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("avatar.png");
        std::fs::write(&file, b"preview").unwrap();
        let path = file.to_str().unwrap();
        let mut state = crate::meta::EchoAgentState::default();
        assert!(authorize_avatar(path, &state).is_err());
        state.expert_sessions.insert(
            "saved-session".into(),
            crate::meta::ExpertBinding {
                expert_id: "review".into(),
                expert_name: "Review".into(),
                source: "local".into(),
                avatar_local: Some(path.into()),
            },
        );
        assert_eq!(
            authorize_avatar(path, &state).unwrap(),
            file.canonicalize().unwrap()
        );
        assert!(authorize_avatar("/etc/passwd", &state).is_err());
    }
}
