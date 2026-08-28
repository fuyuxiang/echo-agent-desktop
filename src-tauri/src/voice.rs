//! Native voice dictation bridge.
//!
//! WKWebView/WebView2 do not reliably expose Web Speech recognition. The
//! embedded upstream voice crate already supplies CoreAudio/WASAPI/Linux mic
//! capture plus xAI streaming STT, so this module exposes that implementation
//! to the Tauri UI while keeping credentials entirely in the Rust process.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use xai_grok_voice::{StaticVoiceAuth, VoiceCommand, VoiceConfig, VoiceEvent};

use crate::commands::AppState;

struct VoiceRuntime {
    commands: mpsc::Sender<VoiceCommand>,
}

static RUNTIME: OnceLock<Mutex<Option<VoiceRuntime>>> = OnceLock::new();

fn runtime() -> &'static Mutex<Option<VoiceRuntime>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceFrontendEvent {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

fn frontend_event(event: VoiceEvent) -> VoiceFrontendEvent {
    match event {
        VoiceEvent::InterimTranscript { text } => VoiceFrontendEvent {
            kind: "interim",
            text: Some(text),
            message: None,
            hint: None,
        },
        VoiceEvent::UtteranceFinal { text } => VoiceFrontendEvent {
            kind: "final",
            text: Some(text),
            message: None,
            hint: None,
        },
        VoiceEvent::Error { message, hint } => VoiceFrontendEvent {
            kind: "error",
            text: None,
            message: Some(message),
            hint,
        },
    }
}

fn configured_voice() -> VoiceConfig {
    // The app currently uses toml 0.8 while the vendored voice crate inherits
    // toml 0.9, so copy the small public settings surface instead of passing a
    // version-specific toml::Table across that crate boundary.
    let raw = crate::providers::read_config();
    let root = raw.as_table();
    let voice = root.and_then(|table| table.get("voice")?.as_table());
    let mut config = VoiceConfig::default();
    let string = |key: &str| {
        voice
            .and_then(|table| table.get(key))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    config.api_base = string("api_base")
        .or_else(|| {
            root.and_then(|table| table.get("endpoints")?.as_table())
                .and_then(|table| table.get("xai_api_base_url"))
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or(config.api_base);
    if let Some(value) = string("stt_ws_path") {
        config.stt_ws_path = value;
    }
    if let Some(value) = voice
        .and_then(|table| table.get("sample_rate"))
        .and_then(toml::Value::as_integer)
        .and_then(|value| u32::try_from(value).ok())
    {
        config.sample_rate = value;
    }
    if let Some(value) = voice
        .and_then(|table| table.get("stt_endpointing_ms"))
        .and_then(toml::Value::as_integer)
        .and_then(|value| u32::try_from(value).ok())
    {
        config.stt_endpointing_ms = value;
    }
    if let Some(value) = voice
        .and_then(|table| table.get("stt_interim_results"))
        .and_then(toml::Value::as_bool)
    {
        config.stt_interim_results = value;
    }
    config
}

async fn bearer(tx: &xai_acp_lib::AcpAgentTx) -> Result<String, String> {
    let value: serde_json::Value = crate::ext::call_ext(
        tx,
        "x.ai/auth/getBearerToken",
        crate::ext::raw_params(&serde_json::json!({})),
    )
    .await
    .map_err(|e| format!("读取语音认证信息失败：{e}"))?;
    value
        .get("token")
        .and_then(|token| token.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "原生语音识别需要可用于 xAI STT 的 API Key".into())
}

#[tauri::command]
pub fn voice_native_available() -> bool {
    xai_grok_voice::AUDIO_SUPPORTED
}

#[tauri::command]
pub async fn voice_native_start(
    app: AppHandle,
    state: State<'_, AppState>,
    language: Option<String>,
) -> Result<(), String> {
    crate::policy::require_feature("voice")?;
    if !xai_grok_voice::AUDIO_SUPPORTED {
        return Err("当前构建未启用原生麦克风捕获".into());
    }

    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let token = bearer(&tx).await?;
    let auth = StaticVoiceAuth::shared(token).ok_or("语音认证信息为空")?;

    // A fresh pipeline per recording picks up rotated/replaced keys and avoids
    // old trailing transcripts landing in a newer recording.
    if let Some(previous) = runtime().lock().unwrap().take() {
        let _ = previous.commands.try_send(VoiceCommand::Shutdown);
    }

    let mut config = configured_voice();
    config.language = language
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "zh-CN".into());
    config.client_identifier = "echoagent-desktop".into();
    config.user_agent = format!("EchoAgent/{}", env!("CARGO_PKG_VERSION"));

    let (command_tx, command_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(128);
    tokio::spawn(xai_grok_voice::run_voice_pipeline(
        config, auth, command_rx, event_tx,
    ));
    let event_app = app.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let is_error = matches!(event, VoiceEvent::Error { .. });
            let _ = event_app.emit("agent://voice", frontend_event(event));
            if is_error {
                break;
            }
        }
    });

    *runtime().lock().unwrap() = Some(VoiceRuntime {
        commands: command_tx.clone(),
    });
    command_tx
        .send(VoiceCommand::PttPress)
        .await
        .map_err(|_| "启动语音采集失败".to_string())
}

#[tauri::command]
pub async fn voice_native_stop() -> Result<(), String> {
    let commands = runtime()
        .lock()
        .unwrap()
        .as_ref()
        .map(|voice| voice.commands.clone())
        .ok_or("语音采集未启动")?;
    commands
        .send(VoiceCommand::PttRelease)
        .await
        .map_err(|_| "停止语音采集失败".to_string())
}

pub fn shutdown() {
    if let Some(active) = runtime().lock().unwrap().take() {
        let _ = active.commands.try_send(VoiceCommand::Shutdown);
    }
}
