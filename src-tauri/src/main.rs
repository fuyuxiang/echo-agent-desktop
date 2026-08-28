// Prevent additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // xai-grok-voice captures on macOS/Windows in a short-lived child process.
    // Intercept that private subcommand before Tauri or the agent initializes.
    if let Some(code) = xai_grok_voice::maybe_run_capture_subprocess() {
        std::process::exit(code);
    }
    echoagent_lib::run()
}
