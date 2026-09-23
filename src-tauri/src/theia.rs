//! Local Eclipse Theia server for Echo Code. The workbench remains a separate
//! browser application; the EchoAgent runtime and task state stay in Tauri.

use serde::Serialize;
use std::fs::{self, File};
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
    if let Ok(resources) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let bundled = resources.join("theia/node/node.exe");
        #[cfg(not(target_os = "windows"))]
        let bundled = resources.join("theia/node/bin/node");
        if bundled.is_file() {
            return bundled;
        }
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
    if !output.status.success() || major < 22 || major == 23 {
        return Err(format!(
            "Theia 需要 Node.js 22 或更新版本，当前为 {}",
            version.trim()
        ));
    }
    Ok(())
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
    access.require_workspace(&root)?;

    let mut guard = server
        .process
        .lock()
        .map_err(|_| "Theia 状态锁不可用".to_string())?;
    if let Some(running) = guard.as_mut() {
        if running
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
        guard.take();
    }

    let app_dir = browser_app_dir(&app)?;
    let node = node_executable(&app);
    check_node(&node)?;
    // A stable origin lets Theia restore layout and editor state across app
    // launches. Fall back to an ephemeral port if another process owns it.
    let listener = TcpListener::bind("127.0.0.1:41773")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|error| format!("无法分配 Theia 本地端口：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);

    let embed_token = format!("{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("theia-config");
    fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建 IDE 配置目录：{error}"))?;
    let log = File::create(data_dir.join("theia.log"))
        .map_err(|error| format!("无法创建 IDE 日志：{error}"))?;
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
            return Err(format!(
                "Theia 启动后退出：{status}。日志：{}",
                data_dir.join("theia.log").display()
            ));
        }
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}")
                .parse()
                .map_err(|error| format!("端口无效：{error}"))?,
            Duration::from_millis(150),
        )
        .is_ok()
        {
            *guard = Some(RunningServer {
                child,
                port,
                embed_token: embed_token.clone(),
            });
            return Ok(TheiaEndpoint {
                url: format!("http://127.0.0.1:{port}/"),
                embed_token,
            });
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(format!(
        "Theia 启动超时，请查看日志：{}",
        data_dir.join("theia.log").display()
    ))
}
