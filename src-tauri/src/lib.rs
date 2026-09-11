// EchoAgent Tauri backend library entry point.
//
// Spawns the in-process EchoAgent agent (agent_runtime::spawn_agent_runtime), wires the ACP stream
// to Tauri events (bridge::spawn_dispatcher), and registers the command
// table (commands) that the React frontend invokes.

mod agent_admin;
mod agent_config;
mod agent_runtime;
mod agents_store;
mod app_updater;
mod attachment_preview;
mod automations;
mod bridge;
mod coding;
mod coding_workspace;
mod commands;
mod connector_cli;
mod connectors_catalog;
mod experts;
mod ext;
mod logging;
mod mcp;
mod meta;
mod notifications;
mod org;
mod org_mcp;
mod paths;
mod permission_config;
mod personal_knowledge;
mod policy;
mod projects;
mod providers;
mod session_title;
mod sessions;
mod shell_fs;
mod skill_installer;
mod skills;
mod skills_catalog;
mod storage;
mod team_mcp;

use bridge::{FolderTrusts, Permissions, PlanApprovals, Questions};
use commands::AppState;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const DESKTOP_MIN_WIDTH: f64 = 1024.0;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const DESKTOP_MIN_HEIGHT: f64 = 680.0;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct DesktopWindowState {
    width: f64,
    height: f64,
    maximized: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn desktop_window_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("window-state.json"))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn save_desktop_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(maximized) = window.is_maximized() else {
        return;
    };
    let Ok(scale_factor) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let logical = size.to_logical::<f64>(scale_factor);
    if logical.width < DESKTOP_MIN_WIDTH || logical.height < DESKTOP_MIN_HEIGHT {
        return;
    }
    let Some(path) = desktop_window_state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let state = DesktopWindowState {
        width: logical.width,
        height: logical.height,
        maximized,
    };
    if let Ok(payload) = serde_json::to_vec(&state) {
        let _ = crate::paths::write_private_file(&path, &payload);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn restore_desktop_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use tauri::{LogicalSize, Size};

    let Some(path) = desktop_window_state_path(app) else {
        return;
    };
    let Ok(payload) = crate::shell_fs::read_regular_file_bounded(&path, 16 * 1024) else {
        return;
    };
    let Ok(state) = serde_json::from_slice::<DesktopWindowState>(&payload) else {
        return;
    };

    let mut max_width = 4096.0;
    let mut max_height = 2160.0;
    if let Ok(Some(monitor)) = window.current_monitor() {
        if let Ok(scale_factor) = window.scale_factor() {
            let screen = monitor.size().to_logical::<f64>(scale_factor);
            max_width = (screen.width * 0.92).max(DESKTOP_MIN_WIDTH);
            max_height = (screen.height * 0.92).max(DESKTOP_MIN_HEIGHT);
        }
    }

    let width = state.width.clamp(DESKTOP_MIN_WIDTH, max_width);
    let height = state.height.clamp(DESKTOP_MIN_HEIGHT, max_height);
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
    let _ = window.center();
    if state.maximized {
        let _ = window.maximize();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn setup_desktop_lifecycle(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
        Manager, WindowEvent,
    };
    use tauri_plugin_autostart::MacosLauncher;

    app.handle().plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["--background"]),
    ))?;
    automations::sync_autostart_state(app.handle());

    let show = MenuItem::with_id(app, "show", "打开 EchoAgent", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 EchoAgent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                use tauri::Manager;
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    commands::stop_agent_runtime(&state).await;
                    app.exit(0);
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    if let Some(window) = app.get_webview_window("main") {
        restore_desktop_window_state(app.handle(), &window);
        let app_handle = app.handle().clone();
        let close_window = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::Resized(_) => {
                save_desktop_window_state(&app_handle, &close_window);
            }
            WindowEvent::CloseRequested { api, .. } => {
                save_desktop_window_state(&app_handle, &close_window);
                api.prevent_close();
                if automations::should_keep_app_alive() {
                    let _ = close_window.hide();
                } else {
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        commands::stop_agent_runtime(&state).await;
                        app.exit(0);
                    });
                }
            }
            _ => {}
        });
        if std::env::args().any(|arg| arg == "--background") {
            let _ = window.hide();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep the non-blocking file writer alive through the whole Tauri event
    // loop. Release builds on Windows have no console, so this is the primary
    // post-mortem record for startup, model reload and session admission.
    let _logging_guard = logging::init();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        commit = env!("ECHOAGENT_BUILD_COMMIT"),
        build_time = env!("ECHOAGENT_BUILD_TIME"),
        log_dir = %logging::log_dir().display(),
        "EchoAgent process started"
    );

    if let Err(error) = paths::initialize_runtime_home() {
        tracing::error!(%error, "failed to initialize EchoAgent runtime home");
    }
    // 离线租约过期时在 Agent Runtime 启动前移除受管 Skill 注入，
    // 避免已撤权的长期离线客户继续加载企业能力。
    org::enforce_skill_lease();

    // Team MCP server（127.0.0.1 streamable-http）：同步 bind 后台 accept。
    // 必须在任何 new_session 之前 —— 端口即刻写入 BOUND_PORT 供传参。
    team_mcp::serve();
    if let Err(error) = org_mcp::clear_persisted_registration() {
        tracing::warn!(%error, "failed to remove legacy organization MCP registration");
    }

    let builder = tauri::Builder::default();
    // Tauri requires single-instance to be the first registered plugin. A
    // second launch focuses the resident window (which may be tray-hidden)
    // instead of creating another WebView against the same profile.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if !args.iter().any(|arg| arg == "--background") {
            show_main_window(app);
        }
    }));

    builder
        .setup(|app| {
            // The authenticated knowledge bridge is reachable on loopback for
            // personal local knowledge. Organization tools are added only after
            // a verified login and shared-scope bootstrap.
            org_mcp::serve(app.handle().clone());
            org::start_background_sync(app.handle().clone());
            personal_knowledge::start_background_index(app.handle().clone());
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            setup_desktop_lifecycle(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(Permissions::new())
        .manage(Questions::new())
        .manage(PlanApprovals::new())
        .manage(FolderTrusts::new())
        .manage(shell_fs::FilesystemAccess::new())
        .manage(coding_workspace::CodingProcesses::new())
        .manage(org::shared_state())
        .invoke_handler(tauri::generate_handler![
            // session lifecycle
            commands::agent_init,
            commands::agent_auth_status,
            commands::agent_new_session,
            commands::agent_load_session,
            commands::agent_list_sessions,
            commands::agent_list_all_sessions,
            commands::agent_set_model,
            commands::agent_list_workspaces,
            commands::agent_set_knowledge_sources,
            commands::agent_send,
            commands::agent_cancel,
            commands::agent_shutdown,
            commands::agent_resolve_permission,
            commands::agent_resolve_question,
            commands::agent_resolve_plan_approval,
            commands::agent_list_pending_interactions,
            commands::agent_rename_session,
            commands::agent_delete_session,
            commands::agent_set_session_pinned,
            commands::agent_set_session_archived,
            commands::agent_set_session_expert,
            commands::agent_clear_session_expert,
            // signed desktop application updates (private organization CA)
            app_updater::app_update_check,
            app_updater::app_update_install,
            // context usage pill (echo.agent/session/info + echo.agent/session/usage)
            commands::agent_session_info,
            commands::agent_session_usage,
            // BYOK providers (~/.echo-agent/config.toml [model.*])
            providers::providers_list,
            providers::providers_save_provider,
            providers::providers_save_connection,
            providers::providers_save_model,
            providers::providers_delete_provider,
            providers::providers_delete_model,
            providers::providers_fetch_models,
            providers::providers_fetch_models_for_provider,
            providers::providers_test_connection,
            providers::providers_test_model_connection,
            // Deprecated shims kept registered for back-compat.
            providers::providers_save,
            providers::providers_delete,
            // default permission rules (~/.echo-agent/config.toml [permission])
            permission_config::permission_list,
            permission_config::permission_save,
            // task-scoped permission mode (sidecar metadata + targeted live notify)
            permission_config::permission_mode_get,
            permission_config::permission_mode_set,
            // agent/assistant defaults (~/.echo-agent/config.toml [models].default + [ui].default_selected_permission)
            permission_config::agents_defaults_get,
            permission_config::agents_defaults_save,
            // authoritative local policy store
            policy::policy_get,
            policy::policy_save,
            // subagents config (~/.echo-agent/config.toml [subagents].max_depth)
            agent_config::subagents_config_get,
            agent_config::subagents_config_save,
            // web search config (~/.echo-agent/config.toml [models].web_search)
            agent_config::web_search_config_get,
            agent_config::web_search_config_save,
            agent_config::memory_config_get,
            agent_config::memory_config_save,
            // skills (echo.agent/skills/*)
            skills::skills_list,
            skills::skills_add,
            skills::skills_remove,
            skills::skills_toggle,
            skill_installer::skills_inspect_package,
            skill_installer::skills_install_package,
            skill_installer::skills_uninstall_package,
            // organization server connection, RAG, documents, and managed Skills
            org::org_login,
            org::org_logout,
            org::org_session,
            org::org_sync_model_config,
            org::org_bootstrap,
            org::org_list_scopes,
            org::org_submit_document,
            org::org_document_submissions_mine,
            org::org_list_documents,
            org::org_list_memories,
            org::org_memory_promotions_mine,
            org::org_submit_memory_candidate,
            org::org_document_status,
            org::org_fetch_document,
            org::org_archive_document,
            org::org_new_document_version,
            org::org_publish_document,
            org::org_list_skills,
            org::org_skill_detail,
            org::org_set_skill_preference,
            org::org_publish_skill,
            org::org_submit_skill,
            org::org_skill_submissions_mine,
            org::org_sync_skills,
            org::org_ask_start,
            org::org_ask_cancel,
            org::org_qa_feedback,
            org::org_local_kb_sources_get,
            org::org_local_kb_sources_set,
            org::personal_knowledge_allowed,
            personal_knowledge::personal_knowledge_search,
            personal_knowledge::personal_knowledge_cancel_search,
            personal_knowledge::personal_knowledge_rebuild,
            personal_knowledge::personal_knowledge_index_status,
            // connectors / MCP (echo.agent/mcp/*)
            mcp::mcp_list,
            mcp::mcp_upsert,
            mcp::mcp_delete,
            mcp::mcp_toggle,
            mcp::mcp_setup,
            mcp::mcp_toggle_tool,
            mcp::mcp_config_path,
            mcp::mcp_config_read,
            mcp::mcp_config_save,
            mcp::mcp_auth_trigger,
            mcp::mcp_auth_status,
            // CLI-type connector authorization (cli.json driven)
            connector_cli::connectors_cli_status,
            connector_cli::connectors_cli_auth,
            connector_cli::connectors_cli_auth_cancel,
            connector_cli::connectors_cli_unauth,
            connector_cli::connectors_cli_skills_dir,
            // experts / assistants (~/.echo-agent/agents/*.md)
            agents_store::agents_list,
            agents_store::agents_get,
            agents_store::agents_save,
            agents_store::agents_delete,
            agents_store::agents_template,
            // expert marketplace (live from a local EchoAgent data dir)
            experts::experts_default_root,
            experts::experts_list_roots,
            experts::experts_load,
            experts::experts_thumbnail,
            experts::experts_image_bytes,
            experts::experts_read_agent_prompt,
            experts::experts_link_agents,
            // Safe, bounded previews for local chat image attachments.
            attachment_preview::attachment_thumbnail,
            // connector marketplace (live from a local EchoAgent marketplace dir)
            connectors_catalog::connectors_default_root,
            connectors_catalog::connectors_list_roots,
            connectors_catalog::connectors_load,
            connectors_catalog::connectors_icon,
            connectors_catalog::connectors_read_mcp_config,
            // skill catalog (runtime scan of agents + builtin skill dirs)
            skills_catalog::skills_catalog_default_root,
            skills_catalog::skills_catalog_list_roots,
            skills_catalog::skills_catalog_load,
            skills_catalog::skills_catalog_read_skill,
            // EchoAgent admin: memory / search / rewind / commands / plan / tasks / reload
            agent_admin::memory_list,
            agent_admin::memory_get,
            agent_admin::memory_save,
            agent_admin::memory_append,
            agent_admin::memory_delete,
            agent_admin::memory_clear_session_summaries,
            agent_admin::memory_rewrite,
            agent_admin::memory_flush,
            agent_admin::memory_dream,
            agent_admin::session_search,
            agent_admin::rewind_points,
            agent_admin::rewind_execute,
            agent_admin::session_fork,
            agent_admin::commands_list,
            agent_admin::prompt_history,
            agent_admin::tasks_list,
            agent_admin::task_kill,
            agent_admin::folder_trust_respond,
            agent_admin::set_plan_mode,
            agent_admin::toggle_plan_mode,
            agent_admin::internal_reload,
            agent_admin::plugins_list,
            agent_admin::plugins_action,
            agent_admin::marketplace_list,
            agent_admin::marketplace_action,
            // authoritative team runtime registry (shared with the MCP tools)
            team_mcp::team_snapshot,
            // notification center
            notifications::notification_append,
            notifications::notification_list,
            notifications::notification_mark_read,
            notifications::notification_mark_all_read,
            notifications::notification_clear,
            notifications::notify_channels_list,
            notifications::notify_channel_upsert,
            notifications::notify_channel_remove,
            notifications::notify_channel_set_enabled,
            notifications::notify_channel_test,
            // automations (local scheduler)
            automations::automations_snapshot,
            automations::automations_save,
            automations::automations_delete,
            automations::automations_set_status,
            automations::automations_run,
            automations::automation_records_archive,
            automations::automation_records_delete,
            // shell / filesystem (markdown links, path click, apply write)
            shell_fs::open_url,
            shell_fs::filesystem_pick_directory,
            shell_fs::filesystem_pick_files,
            shell_fs::open_path,
            shell_fs::reveal_in_folder,
            shell_fs::path_stat,
            shell_fs::read_text_file,
            shell_fs::read_file_base64,
            shell_fs::write_text_file,
            shell_fs::export_text_file,
            shell_fs::list_dir,
            shell_fs::browse_directory,
            shell_fs::echo_agent_data_dir,
            shell_fs::open_echo_agent_data_dir,
            // dedicated Coding Workspace: bounded repository analysis and
            // user-initiated validation commands inside an authorized root
            coding::task::coding_task_list,
            coding::task::coding_task_create,
            coding::task::coding_task_get,
            coding::task::coding_task_delete,
            coding::task::coding_task_rename,
            coding::changeset::coding_changeset_get,
            coding::changeset::coding_changeset_capture_baseline,
            coding::changeset::coding_changeset_discard_file,
            coding::changeset::coding_changeset_mark_reviewed,
            coding::changeset::coding_task_rollback,
            coding::verification::coding_verification_detect,
            coding::verification::coding_verification_list,
            coding::verification::coding_verification_run,
            coding::verification::coding_verification_cancel,
            coding::diagnostics::coding_diagnostics_list,
            coding::orchestrator::coding_task_submit_requirement,
            coding::orchestrator::coding_task_approve_plan,
            coding::orchestrator::coding_orchestrator_report_implementation,
            coding::orchestrator::coding_orchestrator_report_verification,
            coding::orchestrator::coding_orchestrator_state,
            coding::delivery::coding_delivery_report,
            coding::delivery::coding_delivery_commit_input,
            coding::delivery::coding_delivery_pr_input,
            coding::delivery::coding_git_commit,
            coding_workspace::coding_analyze_workspace,
            coding_workspace::coding_git_snapshot,
            coding_workspace::coding_git_diff,
            coding_workspace::coding_git_set_staged,
            coding_workspace::coding_read_document,
            coding_workspace::coding_write_document,
            coding_workspace::coding_create_entry,
            coding_workspace::coding_search_workspace,
            coding_workspace::coding_run_command,
            coding_workspace::coding_cancel_command,
            coding_workspace::coding_terminal_create,
            coding_workspace::coding_terminal_write,
            coding_workspace::coding_terminal_resize,
            coding_workspace::coding_terminal_close,
            // durable local project metadata (renderer localStorage is only a cache)
            projects::projects_load,
            projects::projects_save,
            projects::project_assets_import,
            projects::project_asset_make_dir,
            projects::project_asset_remove,
            projects::project_assets_remove_all,
            // persisted WebDAV cloud storage
            storage::storage_providers_list,
            storage::storage_provider_upsert,
            storage::storage_provider_remove,
            storage::storage_provider_test,
            storage::storage_list,
            storage::storage_read_text,
            storage::storage_write_text,
            storage::storage_upload_file,
            storage::storage_download_file,
            storage::storage_delete,
            storage::storage_make_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EchoAgent");
}
