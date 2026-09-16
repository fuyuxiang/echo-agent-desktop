//! 命令作用域（command scope）权限划分基础设施。
//!
//! Tauri 2 的 capability 权限系统只覆盖内置插件（fs / dialog / shell 等），
//! 自定义 `#[tauri::command]` 默认对所有窗口开放。报告 P0-3 要求「按敏感度拆为
//! fs-read / fs-write / terminal / git / config-read / connector 等 capability」，
//! 在不重写 `generate_handler!` 的前提下，落到本模块做以下事情：
//!
//! 1. 给出 `CommandScope` 枚举（10 个值），覆盖所有 265 个命令的分类空间。
//! 2. 给出 `classify(name)` 按命令前缀（如 `fs_*` / `terminal_*` / `git_*`）归类。
//! 3. 给出 `allowed_scopes_for(window_label)`：默认 `main` 窗口允许除 `MarketplaceInstall`
//!    之外全部 scope；为后续「命令确认弹窗」等独立窗口预留 `confirm` 标签。
//! 4. 给出 `enforce(window_label, command_name)`：不通过时返回 `AppError::permission_denied`。
//!
//! 落地策略：PoC 命令（`coding_verification_approve_plan_command`、`shell_remove` 等高危
//! 命令）在函数体内调用 `enforce`；其余命令分批迁移。文档层另创建
//! `src-tauri/capabilities/*.json` 骨架文件，与本模块保持注释同步。

use std::collections::HashSet;

use crate::error::AppError;

/// 命令作用域分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandScope {
    /// 只读文件系统（list/read/stat）
    FsRead,
    /// 写文件系统（write/remove/move）
    FsWrite,
    /// 终端/进程执行
    Terminal,
    /// Git 操作
    Git,
    /// 只读配置（get_config/list_*）
    ConfigRead,
    /// 写配置（set_config/save_*）
    ConfigWrite,
    /// 模型/Agent 运行时（agent_send/session_*）
    Agent,
    /// Coding 工作台（coding_*）
    Coding,
    /// 系统级（app_exit/update_check）
    System,
    /// Marketplace/插件安装（marketplace_install/plugin_*）
    MarketplaceInstall,
}

/// 默认窗口 → 允许 scope 集合。
///
/// 主窗口（main）放开除 `MarketplaceInstall` 之外全部 scope。
/// `MarketplaceInstall` 在 PoC 阶段需额外弹窗确认；后续通过独立窗口承载。
pub fn allowed_scopes_for(window_label: &str) -> HashSet<CommandScope> {
    let mut set: HashSet<CommandScope> = [
        CommandScope::FsRead,
        CommandScope::FsWrite,
        CommandScope::Terminal,
        CommandScope::Git,
        CommandScope::ConfigRead,
        CommandScope::ConfigWrite,
        CommandScope::Agent,
        CommandScope::Coding,
        CommandScope::System,
    ]
    .into_iter()
    .collect();

    match window_label {
        "main" => {
            set.remove(&CommandScope::MarketplaceInstall);
            set
        }
        "marketplace-confirm" => HashSet::from([CommandScope::MarketplaceInstall]),
        // 任何未声明的窗口：只允许只读，避免误开放。
        _ => HashSet::from([CommandScope::FsRead, CommandScope::ConfigRead]),
    }
}

/// 按命令名前缀/后缀归类。
///
/// 规则（按顺序匹配，第一个命中即返回）：
/// - `marketplace_*` / `plugin_*` / `skills_install` → `MarketplaceInstall`
/// - `coding_*` → `Coding`
/// - `terminal_*` / `shell_*` → `Terminal`
/// - `git_*` → `Git`
/// - `agent_*` / `session_*` / `memory_*` / `model_*` / `provider_*` → `Agent`
/// - `*_list` / `*_get` / `*_read` / `*_stat` / `*_show` / `*_preview` → `FsRead`（白名单追加）
/// - `*_write` / `*_remove` / `*_delete` / `*_save` / `*_set` / `*_move` / `*_import` → `FsWrite` / `ConfigWrite`
/// - `update_*` / `app_*` → `System`
/// - 兜底：默认 `Agent`（绝大多数 `*` 命令属于 agent/config 命名空间）
pub fn classify(name: &str) -> CommandScope {
    // 1. 强语义前缀（命令域唯一归属）
    if name.starts_with("marketplace_") || name.starts_with("plugin_") || name == "skills_install" {
        return CommandScope::MarketplaceInstall;
    }
    if name.starts_with("coding_") {
        return CommandScope::Coding;
    }
    if name.starts_with("terminal_") || name.starts_with("shell_") {
        return CommandScope::Terminal;
    }
    if name.starts_with("git_") {
        return CommandScope::Git;
    }
    if name.starts_with("update_") || name.starts_with("app_") {
        return CommandScope::System;
    }
    // 2. 动作语义后缀（读写写删/导出）— 比命名空间前缀优先
    let write_suffixes = [
        "_write",
        "_remove",
        "_delete",
        "_save",
        "_set",
        "_move",
        "_import",
        "_export",
        "_download",
    ];
    for s in write_suffixes {
        if name.ends_with(s) {
            if name.contains("config") || name.contains("setting") || name.contains("preference") {
                return CommandScope::ConfigWrite;
            }
            return CommandScope::FsWrite;
        }
    }
    let read_suffixes = ["_list", "_get", "_read", "_stat", "_show", "_preview"];
    for s in read_suffixes {
        if name.ends_with(s) {
            if name.contains("config") || name.contains("setting") {
                return CommandScope::ConfigRead;
            }
            return CommandScope::FsRead;
        }
    }
    // 3. 命名空间前缀（agent/session/memory/model/provider）— 兜底前最后一层
    if name.starts_with("agent_")
        || name.starts_with("session_")
        || name.starts_with("memory_")
        || name.starts_with("model_")
        || name.starts_with("provider_")
    {
        return CommandScope::Agent;
    }
    // 4. 兜底：放 Agent
    CommandScope::Agent
}

/// 校验 window_label 调用 command_name 是否被允许。
pub fn enforce(window_label: &str, command_name: &str) -> Result<(), AppError> {
    let allowed = allowed_scopes_for(window_label);
    let scope = classify(command_name);
    if allowed.contains(&scope) {
        Ok(())
    } else {
        Err(AppError::capability_denied(format!(
            "窗口 {} 无权调用命令 {}（scope={:?}）",
            window_label, command_name, scope
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_marketplace_install() {
        assert_eq!(classify("marketplace_install"), CommandScope::MarketplaceInstall);
        assert_eq!(classify("plugin_load"), CommandScope::MarketplaceInstall);
        assert_eq!(classify("skills_install"), CommandScope::MarketplaceInstall);
    }

    #[test]
    fn classify_coding_scope() {
        assert_eq!(classify("coding_task_list"), CommandScope::Coding);
        assert_eq!(classify("coding_workspace_open"), CommandScope::Coding);
    }

    #[test]
    fn classify_terminal_scope() {
        assert_eq!(classify("terminal_run"), CommandScope::Terminal);
        assert_eq!(classify("shell_exec"), CommandScope::Terminal);
    }

    #[test]
    fn classify_git_scope() {
        assert_eq!(classify("git_status"), CommandScope::Git);
        assert_eq!(classify("git_diff"), CommandScope::Git);
    }

    #[test]
    fn classify_agent_scope() {
        assert_eq!(classify("agent_send"), CommandScope::Agent);
        assert_eq!(classify("session_start"), CommandScope::Agent);
        assert_eq!(classify("memory_clear"), CommandScope::Agent);
    }

    #[test]
    fn classify_read_suffix_to_fs_read() {
        assert_eq!(classify("file_list"), CommandScope::FsRead);
        assert_eq!(classify("project_get"), CommandScope::FsRead);
        assert_eq!(classify("session_read"), CommandScope::FsRead);
    }

    #[test]
    fn classify_write_suffix_to_fs_write() {
        assert_eq!(classify("file_write"), CommandScope::FsWrite);
        assert_eq!(classify("file_remove"), CommandScope::FsWrite);
        assert_eq!(classify("artifact_save"), CommandScope::FsWrite);
    }

    #[test]
    fn classify_config_suffix_to_config_scopes() {
        assert_eq!(classify("config_read"), CommandScope::ConfigRead);
        assert_eq!(classify("config_write"), CommandScope::ConfigWrite);
        assert_eq!(classify("setting_set"), CommandScope::ConfigWrite);
    }

    #[test]
    fn main_window_allows_agent_but_not_marketplace() {
        let allowed = allowed_scopes_for("main");
        assert!(allowed.contains(&CommandScope::Agent));
        assert!(allowed.contains(&CommandScope::Coding));
        assert!(allowed.contains(&CommandScope::FsRead));
        assert!(!allowed.contains(&CommandScope::MarketplaceInstall));
    }

    #[test]
    fn marketplace_confirm_window_allows_only_marketplace() {
        let allowed = allowed_scopes_for("marketplace-confirm");
        assert_eq!(allowed.len(), 1);
        assert!(allowed.contains(&CommandScope::MarketplaceInstall));
    }

    #[test]
    fn unknown_window_only_allows_read() {
        let allowed = allowed_scopes_for("rogue");
        assert!(allowed.contains(&CommandScope::FsRead));
        assert!(allowed.contains(&CommandScope::ConfigRead));
        assert!(!allowed.contains(&CommandScope::FsWrite));
        assert!(!allowed.contains(&CommandScope::Agent));
    }

    #[test]
    fn enforce_rejects_marketplace_install_from_main() {
        let result = enforce("main", "marketplace_install");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code.0, crate::error::ErrorCode::CAPABILITY_DENIED.0);
        assert_eq!(err.kind, crate::error::ErrorKind::Permission);
    }

    #[test]
    fn enforce_allows_agent_command_from_main() {
        assert!(enforce("main", "agent_send").is_ok());
        assert!(enforce("main", "coding_task_list").is_ok());
    }

    #[test]
    fn enforce_allows_marketplace_install_from_confirm_window() {
        assert!(enforce("marketplace-confirm", "marketplace_install").is_ok());
    }

    #[test]
    fn enforce_rejects_write_from_readonly_window() {
        let result = enforce("rogue", "file_write");
        assert!(result.is_err());
    }
}
