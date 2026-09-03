//! Production logging that survives the Windows GUI subsystem's hidden console.

use std::path::PathBuf;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const LOG_RETENTION_DAYS: u64 = 14;

pub(crate) fn log_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(crate::paths::echo_agent_home_dir)
        .join("EchoAgent")
        .join("logs")
}

fn remove_expired_logs(directory: &std::path::Path) {
    let cutoff = std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(
        60 * 60 * 24 * LOG_RETENTION_DAYS,
    ));
    let Some(cutoff) = cutoff else { return };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_echoagent_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("echoagent.log"));
        if !is_echoagent_log {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified < cutoff);
        if expired {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Install a daily rolling file subscriber. The returned guard must live for
/// the entire process so the non-blocking writer can flush queued records.
pub(crate) fn init() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let directory = log_dir();
    if std::fs::create_dir_all(&directory).is_err() {
        return None;
    }
    remove_expired_logs(&directory);

    let appender = tracing_appender::rolling::daily(&directory, "echoagent.log");
    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("echoagent=info,echoagent_lib=info,xai_grok_shell=info,warn")
    });
    let subscriber = tracing_subscriber::registry().with(filter).with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_target(true)
            .with_writer(file_writer),
    );

    #[cfg(debug_assertions)]
    let initialized = subscriber
        .with(tracing_subscriber::fmt::layer().with_target(true))
        .try_init();
    #[cfg(not(debug_assertions))]
    let initialized = subscriber.try_init();

    if initialized.is_err() {
        return None;
    }
    Some(guard)
}
