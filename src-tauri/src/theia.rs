//! Local Eclipse Theia server for Echo Code. The workbench remains a separate
//! browser application; the EchoAgent runtime and task state stay in Tauri.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::shell_fs::FilesystemAccess;

#[derive(Default)]
pub struct TheiaServer {
    process: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    child: Child,
    port: u16,
    embed_token: String,
    root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheiaEndpoint {
    url: String,
    embed_token: String,
}

impl TheiaServer {
    pub fn stop(&self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut running) = guard.take() {
                let _ = running.child.kill();
                let _ = running.child.wait();
            }
        }
    }
}

impl Drop for TheiaServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn browser_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        // During development, ide:stage refreshes this directory without
        // rebuilding the Tauri resource bundle next to the debug binary.
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/theia/browser");
        if staged.join("lib/backend/main.js").is_file() {
            return Ok(staged);
        }
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源：{error}"))?
        .join("theia/browser");
    if bundled.join("lib/backend/main.js").is_file() {
        return Ok(bundled);
    }
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/theia-platform/examples/browser");
    if source.join("lib/backend/main.js").is_file() {
        return Ok(source);
    }
    Err("Theia 尚未构建。请先运行 pnpm ide:build。".into())
}

fn node_executable(app: &AppHandle) -> PathBuf {
    if let Ok(explicit) = std::env::var("ECHO_THEIA_NODE") {
        return PathBuf::from(explicit);
    }
    #[cfg(debug_assertions)]
    {
        #[cfg(target_os = "windows")]
        let staged =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/theia/node/node.exe");
        #[cfg(not(target_os = "windows"))]
        let staged =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/theia/node/bin/node");
        if staged.is_file() {
            return staged;
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let bundled = resources.join("theia/node/node.exe");
        #[cfg(not(target_os = "windows"))]
        let bundled = resources.join("theia/node/bin/node");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

fn check_node(node: &PathBuf) -> Result<(), String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("无法启动 Theia 的 Node.js：{error}"))?;
    let version = String::from_utf8_lossy(&output.stdout);
    let major = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if !output.status.success() || !matches!(major, 22 | 24) {
        return Err(format!(
            "Theia 当前支持已验证的 Node.js 22 或 24，当前为 {}",
            version.trim()
        ));
    }
    Ok(())
}

fn theia_ready(port: u16, embed_token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback address"),
        Duration::from_millis(150),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    let request = format!(
        "GET /__echo_health?echoEmbedToken={embed_token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 204")
        && response
            .lines()
            .any(|line| line.trim_end_matches('\r') == format!("X-Echo-Theia-Ready: {embed_token}"))
}

#[tauri::command]
pub async fn coding_theia_start(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    server: State<'_, TheiaServer>,
    root: String,
) -> Result<TheiaEndpoint, String> {
    // Theia receives the selected root via the browser URL fragment. Reuse
    // EchoAgent's workspace allow-list before exposing that folder to the IDE.
    let authorized_root = access.require_workspace(&root)?;

    let mut guard = server
        .process
        .lock()
        .map_err(|_| "Theia 状态锁不可用".to_string())?;
    if let Some(running) = guard.as_mut() {
        if running.root == authorized_root
            && running
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
        {
            return Ok(TheiaEndpoint {
                url: format!("http://127.0.0.1:{}/", running.port),
                embed_token: running.embed_token.clone(),
            });
        }
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    let app_dir = browser_app_dir(&app)?;
    let node = node_executable(&app);
    check_node(&node)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("theia-config");
    fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建 IDE 配置目录：{error}"))?;
    let log_path = data_dir.join("theia.log");
    for attempt in 0..3 {
        // The preferred origin restores layout. A bind/drop/spawn race can
        // still occur; an occupied port gets a fresh ephemeral retry.
        let listener = if attempt == 0 {
            TcpListener::bind("127.0.0.1:41773").or_else(|_| TcpListener::bind("127.0.0.1:0"))
        } else {
            TcpListener::bind("127.0.0.1:0")
        }
        .map_err(|error| format!("无法分配 Theia 本地端口：{error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        drop(listener);

        let embed_token = format!("{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
        let log = File::create(&log_path).map_err(|error| format!("无法创建 IDE 日志：{error}"))?;
        let err_log = log.try_clone().map_err(|error| error.to_string())?;
        let mut child = Command::new(&node)
            .arg(app_dir.join("lib/backend/main.js"))
            .arg(format!("--port={port}"))
            .arg("--hostname=127.0.0.1")
            .env("THEIA_CONFIG_DIR", &config_dir)
            .env("ECHO_THEIA_EMBED_TOKEN", &embed_token)
            .current_dir(&app_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err_log))
            .spawn()
            .map_err(|error| format!("Theia 启动失败：{error}"))?;

        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                let port_taken = fs::read_to_string(&log_path)
                    .map(|content| content.contains("EADDRINUSE"))
                    .unwrap_or(false);
                if port_taken && attempt < 2 {
                    break;
                }
                return Err(format!(
                    "Theia 启动后退出：{status}。日志：{}",
                    log_path.display()
                ));
            }
            if theia_ready(port, &embed_token) {
                *guard = Some(RunningServer {
                    child,
                    port,
                    embed_token: embed_token.clone(),
                    root: authorized_root,
                });
                return Ok(TheiaEndpoint {
                    url: format!("http://127.0.0.1:{port}/"),
                    embed_token,
                });
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Theia 启动超时，请查看日志：{}",
                log_path.display()
            ));
        }
    }
    Err(format!(
        "Theia 本地端口持续被占用，请查看日志：{}",
        log_path.display()
    ))
}
