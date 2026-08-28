// EchoAgent Tauri backend library entry point.
//
// Spawns the in-process EchoAgent agent (agent_runtime::spawn_agent_runtime), wires the ACP stream
// to Tauri events (bridge::spawn_dispatcher), and registers the command
// table (commands) that the React frontend invokes.

mod agent_admin;
mod agent_config;
mod agent_runtime;
mod agents_store;
mod automations;
mod bridge;
mod commands;
mod connector_cli;
mod connectors_catalog;
mod experts;
mod ext;
mod mcp;
mod meta;
mod notifications;
mod paths;
mod permission_config;
mod policy;
mod providers;
mod sessions;
mod shell_fs;
mod skills;
mod skills_catalog;
mod storage;
mod team_mcp;
mod voice;

use bridge::{Permissions, Questions};
use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging for debugging
    let _ = tracing_subscriber::fmt::try_init();

    if let Err(error) = paths::initialize_runtime_home() {
        tracing::error!(%error, "failed to initialize EchoAgent runtime home");
    }

    // Team MCP server（127.0.0.1 streamable-http）：同步 bind 后台 accept。
    // 必须在任何 new_session 之前 —— 端口即刻写入 BOUND_PORT 供传参。
    team_mcp::serve();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(Permissions::new())
        .manage(Questions::new())
        .invoke_handler(tauri::generate_handler![
            // session lifecycle
            commands::agent_init,
            commands::agent_auth_status,
            commands::agent_new_session,
            commands::agent_load_session,
            commands::agent_list_sessions,
            commands::agent_set_model,
            commands::agent_list_workspaces,
            commands::agent_send,
            commands::agent_cancel,
            commands::agent_shutdown,
            commands::agent_resolve_permission,
            commands::agent_resolve_question,
            commands::agent_rename_session,
            commands::agent_delete_session,
            commands::agent_set_session_pinned,
            commands::agent_set_session_archived,
            commands::agent_set_session_expert,
            commands::agent_clear_session_expert,
            // context usage pill (x.ai/session/info + x.ai/session/usage)
            commands::agent_session_info,
            commands::agent_session_usage,
            // BYOK providers (~/.echo-agent/config.toml [model.*])
            providers::providers_list,
            providers::providers_save_provider,
            providers::providers_save_model,
            providers::providers_delete_provider,
            providers::providers_delete_model,
            providers::providers_fetch_models,
            // Deprecated shims kept registered for back-compat.
            providers::providers_save,
            providers::providers_delete,
            // default permission rules (~/.echo-agent/config.toml [permission])
            permission_config::permission_list,
            permission_config::permission_save,
            // permission mode (~/.echo-agent/config.toml [ui].permission_mode + live notify)
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
            // skills (x.ai/skills/*)
            skills::skills_list,
            skills::skills_add,
            skills::skills_remove,
            skills::skills_toggle,
            // connectors / MCP (x.ai/mcp/*)
            mcp::mcp_list,
            mcp::mcp_upsert,
            mcp::mcp_delete,
            mcp::mcp_toggle,
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
            // expert marketplace (live from a local WorkBuddy data dir)
            experts::experts_default_root,
            experts::experts_list_roots,
            experts::experts_load,
            experts::experts_thumbnail,
            experts::experts_image_bytes,
            experts::experts_read_agent_prompt,
            experts::experts_link_agents,
            // connector marketplace (live from a local WorkBuddy marketplace dir)
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
            agent_admin::memory_delete,
            agent_admin::memory_rewrite,
            agent_admin::memory_flush,
            agent_admin::session_search,
            agent_admin::rewind_points,
            agent_admin::rewind_execute,
            agent_admin::session_fork,
            agent_admin::commands_list,
            agent_admin::prompt_history,
            agent_admin::tasks_list,
            agent_admin::task_kill,
            agent_admin::folder_trust_respond,
            agent_admin::toggle_plan_mode,
            agent_admin::internal_reload,
            agent_admin::inspiration_generate,
            agent_admin::account_get_api_key,
            agent_admin::account_set_api_key,
            agent_admin::plugins_list,
            agent_admin::plugins_action,
            agent_admin::marketplace_list,
            agent_admin::marketplace_action,
            // notification log (智能体邮箱 → 会话通知中心)
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
            shell_fs::open_path,
            shell_fs::reveal_in_folder,
            shell_fs::path_stat,
            shell_fs::read_text_file,
            shell_fs::read_file_base64,
            shell_fs::write_text_file,
            shell_fs::export_text_file,
            shell_fs::list_dir,
            shell_fs::browse_directory,
            // persisted WebDAV cloud storage
            storage::storage_providers_list,
            storage::storage_provider_upsert,
            storage::storage_provider_remove,
            storage::storage_provider_test,
            storage::storage_list,
            storage::storage_read_text,
            storage::storage_write_text,
            storage::storage_delete,
            storage::storage_make_dir,
            // native microphone + streaming speech-to-text fallback
            voice::voice_native_available,
            voice::voice_native_start,
            voice::voice_native_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EchoAgent");
}
