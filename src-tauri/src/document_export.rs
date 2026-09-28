//! First-party office export. The worker is bundled with the desktop app; user
//! documents never need a host Python, Node, LibreOffice, or an online converter.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 50 * 1024 * 1024;
const EXPORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportRequest {
    pub(crate) title: String,
    pub(crate) markdown: String,
    pub(crate) format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportReceipt {
    pub(crate) path: String,
    format: String,
    byte_size: u64,
    sha256: String,
}

fn valid_format(format: &str) -> bool {
    matches!(format, "docx" | "pdf" | "xlsx" | "pptx")
}

pub(crate) fn safe_file_title(title: &str) -> String {
    let name: String = title
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            value if value.is_control() => ' ',
            value => value,
        })
        .take(80)
        .collect();
    let name = name.trim().trim_end_matches(['.', ' ']);
    if name.is_empty() {
        "办公文档".to_string()
    } else if matches!(
        name.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        format!("_{name}")
    } else {
        name.to_string()
    }
}

fn office_resource(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/office")
            .join(relative);
        if staged.is_file() {
            return Ok(staged);
        }
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位文档资源：{error}"))?
        .join("office")
        .join(relative);
    if bundled.is_file() {
        Ok(bundled)
    } else {
        Err(format!("安装包缺少文档处理资源：{relative}"))
    }
}

fn validate_output(path: &Path, format: &str) -> Result<(u64, String), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("文档未生成：{error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("生成结果不是普通文件".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_OUTPUT_BYTES {
        return Err("生成文件为空或超过 50 MiB 上限".into());
    }
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法检查生成文件：{error}"))?;
    if format == "pdf" {
        let mut head = [0u8; 5];
        file.read_exact(&mut head)
            .map_err(|error| error.to_string())?;
        if &head != b"%PDF-" {
            return Err("生成的 PDF 文件头无效".into());
        }
    } else {
        let expected = match format {
            "docx" => "word/document.xml",
            "xlsx" => "xl/workbook.xml",
            "pptx" => "ppt/presentation.xml",
            _ => return Err("不支持的文档格式".into()),
        };
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| format!("生成的 Office 文件无法打开：{error}"))?;
        if archive.by_name(expected).is_err() {
            return Err(format!("生成的 Office 文件缺少 {expected}"));
        }
        file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("计算文件摘要失败：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok((metadata.len(), format!("{:x}", hasher.finalize())))
}

fn install_output(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("无效的保存目录")?;
    let stage = tempfile::Builder::new()
        .prefix(".echo-office-stage-")
        .tempfile_in(parent)
        .map_err(|error| format!("无法在保存目录创建临时文件：{error}"))?;
    std::fs::copy(source, stage.path()).map_err(|error| format!("复制文档失败：{error}"))?;
    stage
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步文档临时文件：{error}"))?;
    let (stage_file, stage_path) = stage.keep().map_err(|error| error.error.to_string())?;
    drop(stage_file);
    let backup = parent.join(format!(".echo-office-backup-{}", uuid::Uuid::now_v7()));
    let had_original = destination.exists();
    if had_original {
        if let Err(error) = std::fs::rename(destination, &backup) {
            let _ = std::fs::remove_file(&stage_path);
            return Err(format!("无法保护原文件：{error}"));
        }
    }
    if let Err(error) = std::fs::rename(&stage_path, destination) {
        if had_original {
            let _ = std::fs::rename(&backup, destination);
        }
        let _ = std::fs::remove_file(&stage_path);
        return Err(format!("保存文档失败：{error}"));
    }
    if had_original {
        let _ = std::fs::remove_file(&backup);
    }
    Ok(())
}

async fn generate(
    app: &AppHandle,
    request: &DocumentExportRequest,
    output: &Path,
) -> Result<(), String> {
    let script = office_resource(app, "worker.mjs")?;
    let font = office_resource(app, "fonts/NotoSansCJKsc-Regular.otf")?;
    let executable = crate::theia::node_executable(app);
    let executable = crate::theia::node_compatible_path(&executable)?;
    let script = crate::theia::node_compatible_path(&script)?;
    let output = crate::theia::node_compatible_path(output)?;
    let font = crate::theia::node_compatible_path(&font)?;
    let mut worker = tokio::process::Command::new(executable);
    worker
        .arg("--max-old-space-size=512")
        .arg(script)
        .arg(output)
        .arg(font)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    worker.creation_flags(crate::process_supervisor::CREATE_NO_WINDOW);
    let mut child = worker
        .spawn()
        .map_err(|error| format!("无法启动内置文档处理程序：{error}"))?;
    let data = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or("文档处理程序无法接收内容")?;
    stdin
        .write_all(&data)
        .await
        .map_err(|error| error.to_string())?;
    drop(stdin);
    let result = tokio::time::timeout(EXPORT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "生成文档超时".to_string())?
        .map_err(|error| format!("文档处理程序异常退出：{error}"))?;
    if !result.status.success() {
        let details = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "生成文档失败：{}",
            details.chars().take(400).collect::<String>()
        ));
    }
    Ok(())
}

pub async fn export(
    app: &AppHandle,
    request: DocumentExportRequest,
) -> Result<Option<DocumentExportReceipt>, String> {
    validate_request(&request)?;
    let filename = format!("{}.{}", safe_file_title(&request.title), request.format);
    let Some(mut destination) =
        crate::meeting_minutes::choose_save_path(app, "导出办公文档", &filename, &request.format)
            .await?
    else {
        return Ok(None);
    };
    if destination.extension().is_none() {
        destination.set_extension(&request.format);
    }
    export_to_path(app, request, &destination).await.map(Some)
}

pub(crate) fn validate_request(request: &DocumentExportRequest) -> Result<(), String> {
    if !valid_format(&request.format) {
        return Err("不支持的导出格式".into());
    }
    if request.markdown.trim().is_empty() || request.markdown.len() > MAX_MARKDOWN_BYTES {
        return Err("文档内容为空或超过 2 MiB 上限".into());
    }
    if request.title.chars().count() > 160 {
        return Err("文档标题过长".into());
    }
    Ok(())
}

pub(crate) async fn export_to_path(
    app: &AppHandle,
    request: DocumentExportRequest,
    destination: &Path,
) -> Result<DocumentExportReceipt, String> {
    validate_request(&request)?;
    if !destination
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(&request.format))
    {
        return Err("保存路径的扩展名与文档格式不一致".into());
    }
    let temp = tempfile::tempdir().map_err(|error| format!("无法创建文档临时目录：{error}"))?;
    let output = temp.path().join(format!("output.{}", request.format));
    generate(app, &request, &output).await?;
    let (byte_size, sha256) = validate_output(&output, &request.format)?;
    install_output(&output, destination)?;
    Ok(DocumentExportReceipt {
        path: destination.to_string_lossy().into_owned(),
        format: request.format,
        byte_size,
        sha256,
    })
}

#[tauri::command]
pub async fn document_export(
    app: AppHandle,
    access: tauri::State<'_, crate::shell_fs::FilesystemAccess>,
    request: DocumentExportRequest,
) -> Result<Option<DocumentExportReceipt>, String> {
    let result = export(&app, request).await?;
    if let Some(receipt) = &result {
        access.authorize_file(Path::new(&receipt.path))?;
    }
    Ok(result)
}
