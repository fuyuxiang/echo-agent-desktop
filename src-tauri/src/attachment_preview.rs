//! Safe, bounded thumbnails for local chat attachments.
//!
//! The frontend deliberately does not expose arbitrary local paths through
//! Tauri's asset protocol. Instead it requests a small JPEG for image formats
//! the agent itself accepts as multimodal prompt content.

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use base64::Engine as _;

const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 20_000;
const MAX_DECODE_ALLOC: u64 = 160 * 1024 * 1024;
const THUMB_LONG_EDGE: u32 = 320;
const THUMB_QUALITY: u8 = 82;

fn supported_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp")
    )
}

fn cache_path(cache_dir: &Path, source: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    cache_dir.join(format!("{:016x}.jpg", hasher.finish()))
}

fn cache_is_fresh(cache: &Path, source_modified: Option<SystemTime>) -> bool {
    let Ok(cache_meta) = std::fs::metadata(cache) else {
        return false;
    };
    if cache_meta.len() == 0 {
        return false;
    }
    match (cache_meta.modified().ok(), source_modified) {
        (Some(cache_modified), Some(source_modified)) => cache_modified >= source_modified,
        (Some(_), None) => true,
        _ => false,
    }
}

fn flatten_over_white(image: image::RgbaImage) -> image::RgbImage {
    image::RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let pixel = image.get_pixel(x, y).0;
        let alpha = u16::from(pixel[3]);
        let blend =
            |channel: u8| (((u16::from(channel) * alpha) + (255 * (255 - alpha))) / 255) as u8;
        image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])])
    })
}

fn make_thumbnail_sync(source: &Path, cache_dir: &Path) -> Result<String, String> {
    if !supported_extension(source) {
        return Err("不支持的图片附件格式".into());
    }
    let source_meta =
        std::fs::metadata(source).map_err(|error| format!("读取图片信息失败：{error}"))?;
    if !source_meta.is_file() {
        return Err("图片附件不是文件".into());
    }
    if source_meta.len() > MAX_SOURCE_BYTES {
        return Err("图片附件超过 20MB".into());
    }

    let cache = cache_path(cache_dir, source);
    if cache_is_fresh(&cache, source_meta.modified().ok()) {
        let bytes =
            std::fs::read(&cache).map_err(|error| format!("读取缩略图缓存失败：{error}"))?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
    }

    let mut reader = image::ImageReader::open(source)
        .map_err(|error| format!("打开图片失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别图片格式失败：{error}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| format!("解码图片失败：{error}"))?;
    let thumbnail = decoded.thumbnail(THUMB_LONG_EDGE, THUMB_LONG_EDGE);
    let rgb = flatten_over_white(thumbnail.to_rgba8());
    let (width, height) = rgb.dimensions();
    let mut jpeg = Vec::with_capacity(32 * 1024);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, THUMB_QUALITY);
    encoder
        .encode(rgb.as_raw(), width, height, image::ColorType::Rgb8.into())
        .map_err(|error| format!("编码缩略图失败：{error}"))?;

    if let Err(error) = std::fs::create_dir_all(cache_dir) {
        tracing::warn!(error = %error, path = %cache_dir.display(), "failed to create attachment thumbnail cache");
    } else if let Err(error) = std::fs::write(&cache, &jpeg) {
        tracing::warn!(error = %error, path = %cache.display(), "failed to cache attachment thumbnail");
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

async fn make_thumbnail(source: PathBuf, cache_dir: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || make_thumbnail_sync(&source, &cache_dir))
        .await
        .map_err(|error| format!("缩略图任务失败：{error}"))?
}

#[tauri::command]
pub async fn attachment_thumbnail(path: String) -> Result<String, String> {
    make_thumbnail(
        PathBuf::from(path),
        crate::paths::echo_agent_home_dir().join("attachment-thumbs"),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_a_bounded_jpeg_and_reuses_the_cache() {
        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("sample.png");
        let cache = temp.path().join("cache");
        let image = image::RgbaImage::from_pixel(640, 320, image::Rgba([12, 34, 56, 128]));
        image.save(&source).expect("write source png");

        let first = make_thumbnail(source.clone(), cache.clone())
            .await
            .expect("create thumbnail");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(first)
            .expect("base64 jpeg");
        assert!(bytes.starts_with(&[0xff, 0xd8, 0xff]));
        let cached_files = std::fs::read_dir(&cache)
            .expect("cache directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("cache entries");
        assert_eq!(cached_files.len(), 1);

        let second = make_thumbnail(source, cache)
            .await
            .expect("cached thumbnail");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(bytes),
            second
        );
    }

    #[tokio::test]
    async fn rejects_non_image_extensions_before_decoding() {
        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("notes.txt");
        std::fs::write(&source, b"not an image").expect("write source");

        let error = make_thumbnail(source, temp.path().join("cache"))
            .await
            .expect_err("text files are not thumbnails");
        assert!(error.contains("不支持"));
    }
}
