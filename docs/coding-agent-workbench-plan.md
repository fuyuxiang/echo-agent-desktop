# Coding Agent 工作台第一期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有「更多 → 代码开发」重建为生产级 Coding Agent 工作台，打通 Requirement → Task → ChangeSet → Verification → Diagnostics → Repair → Gate → Delivery 主链，闭环由 Rust 侧硬编排。

**Architecture:** 前端新建 `src/features/coding/`，按 shell / explorer / main / agent / panels / commands / store 分层，每文件 < 400 行；业务状态单一数据源下沉 Rust，新增 7 个模块，沿用项目既有 JSON/JSONL 文件持久化（不引入新依赖）；旧 `src/components/coding-workspace/` 在最后一个任务整体删除。

**Tech Stack:** React 18 + TypeScript + Zustand + Monaco + xterm.js；Rust + Tauri 2 + tokio + serde_json；测试用 vitest（前端）与 cargo test（后端）。

**Spec:** `docs/coding-agent-workbench-design.md`

## Global Constraints

- 语言：所有代码注释、变量名用英文；所有 UI 文案、提交信息、文档用简体中文。
- 隔离：新增前端代码只允许放在 `src/features/coding/`；唯一挂载点是 `src/components/PlaceholderPage.tsx` 的 `label === "代码开发"` 分支。禁止修改 `src/App.tsx` 主聊天链路、禁止修改共享 store 的现有字段。
- 共享组件只读复用，不改签名：`ModelSelector`、`PermissionPicker`、`PermissionInlineCard`、`QuestionInlineCard`、`ExecutionProcess`、`InputAddMenu`、`ContextUsagePill`、`Markdown`、`FileTreeView`。
- 样式：新样式写入 `src/styles/coding-workbench.css`，所有选择器必须在 `.coding-workbench` 作用域内；色值只允许用 `tokens.css` 的 CSS 变量，禁止硬编码 hex，禁止 `color-scheme: dark`。
- Rust 持久化根目录：`crate::paths::echo_agent_home_dir().join("coding")`。禁止引入新的 Cargo 依赖（不加 rusqlite / tree-sitter / git2）。
- Rust 文件 IO：禁止在 `async fn` 内直接调用 `std::fs`；必须用 `tokio::fs` 或 `tokio::task::spawn_blocking`。
- 工作区路径校验：所有接收 `root` 参数的 Tauri 命令必须先调用 `access.require_workspace(&root)?`（`State<'_, FilesystemAccess>`）。
- 命令注册：新增 Tauri 命令必须加进 `src-tauri/src/lib.rs` 的 `invoke_handler` 列表，模块用 `mod` 声明。
- 前端测试命令：`pnpm test`（vitest run）。类型与构建检查：`pnpm build`（tsc --noEmit && vite build）。
- Rust 测试命令：`cd src-tauri && cargo test`。
- 提交信息格式：四段式中文（摘要 / 原因 / 关键实现列表 / 验证），不加 `feat:` 等前缀，不加任何 Claude/Anthropic 署名。
- 每个任务结束必须提交一次，提交前跑通该任务涉及的测试。

---

## 文件结构

### 前端新增（`src/features/coding/`）

| 文件 | 职责 |
|---|---|
| `CodingWorkbench.tsx` | 布局骨架：grid、可拖栏宽、折叠、挂载各区 |
| `store/workbench-store.ts` | UI 态：tab 列表、活动视图、栏宽、底部面板 |
| `store/task-store.ts` | 任务态只读镜像：订阅 Rust 事件 |
| `lib/tauri-api.ts` | 新增 Tauri 命令的 TS 封装 |
| `lib/commands.ts` | 命令注册表：id、标题、分组、快捷键、执行体 |
| `shell/TopBar.tsx` | 仓库信息、任务切换器、⌘K 入口 |
| `shell/ActivityBar.tsx` | 5 项活动栏 |
| `shell/StatusBar.tsx` | 任务进度、问题数、验证图标、变更数、用量 |
| `shell/CommandPalette.tsx` | ⌘K / ⌘P / ⌘T 三模式面板 |
| `explorer/ExplorerPane.tsx` | 活动栏视图容器 |
| `explorer/SearchView.tsx` | 全文搜索 + 替换 |
| `explorer/ChangeSetView.tsx` | 变更集、暂存/丢弃、提交 |
| `explorer/SymbolView.tsx` | 符号列表（第一期基于 Monaco） |
| `explorer/ContextPackView.tsx` | 上下文清单与 token 占用 |
| `main/TabContainer.tsx` | tab 条与内容槽位 |
| `main/EditorTab.tsx` | Monaco 编辑器 + 面包屑 + 主题联动 |
| `main/DiffTab.tsx` | diff 视图 |
| `main/docs/DeliveryReportTab.tsx` | 交付报告 |
| `main/docs/TaskDagTab.tsx` | Task DAG |
| `main/docs/ProjectProfileTab.tsx` | 工程画像 |
| `agent/AgentPane.tsx` | 执行流、决策卡片、输入区 |
| `panels/BottomPanel.tsx` | 终端/问题/测试/输出/轨迹 |
| `panels/ProblemsView.tsx` | 结构化诊断列表 |
| `panels/VerificationView.tsx` | 验证记录 |

### Rust 新增（`src-tauri/src/`）

| 文件 | 职责 |
|---|---|
| `coding/mod.rs` | 子模块声明与共享类型 |
| `coding/store.rs` | JSON/JSONL 持久化读写、目录布局 |
| `coding/task.rs` | 任务 CRUD、多任务并存、恢复 |
| `coding/changeset.rs` | 变更记录、回滚、用户改动保护 |
| `coding/verification.rs` | 命令识别、执行、结果结构化解析 |
| `coding/diagnostics.rs` | 各类错误解析为 Problem |
| `coding/orchestrator.rs` | 阶段状态机、闭环推进、门禁卡控 |
| `coding/delivery.rs` | 门禁判定、交付报告、Evidence 聚合 |

### 修改

- `src-tauri/src/lib.rs`：注册新模块与命令。
- `src-tauri/src/coding_workspace.rs`：修复 25 处阻塞 IO；删除 `coding_run_command` / `coding_cancel_command`（迁入 verification）。
- `src/components/PlaceholderPage.tsx`：挂载点换成 `CodingWorkbench`。
- `src/styles/coding-workbench.css`：新建。
- 删除：`src/components/coding-workspace/`、`src/lib/coding-workspace.ts`、`src/styles/coding-workspace.css` 及其测试（最后一个任务）。

---

## 任务总览

后端 Task 1-8 已实现并提交，共 54 个单元测试 + 3 个契约测试。

| # | 任务 | 交付物 | 状态 |
|---|---|---|---|
| 1 | Rust 持久化层 | 任务目录布局与读写 | 已完成 |
| 2 | Rust 任务管理 | 任务 CRUD 与恢复命令 | 已完成 |
| 3 | Rust ChangeSet | 变更记录、回滚、改动保护 | 已完成 |
| 4 | Rust 验证引擎 | 命令识别、执行、结果解析 | 已完成 |
| 5 | Rust 诊断中心 | 错误解析为 Problem | 已完成 |
| 6 | Rust 编排状态机 | 闭环推进与门禁卡控 | 已完成 |
| 7 | Rust 交付层 | 门禁、报告、Evidence、commit/PR | 已完成 |
| 8 | 阻塞 IO 修复 | coding_workspace.rs 异步化 | 已完成 |
| 9 | 前端骨架与主题 | 布局、栏宽、主题跟随 |
| 10 | 命令面板 | ⌘K/⌘P/⌘T 与命令注册表 |
| 11 | tab 容器与编辑器 | 文件 tab、diff、面包屑 |
| 12 | 活动栏视图 | 文件/搜索/变更/符号/上下文 |
| 13 | Agent 面板 | 执行流、决策卡片、输入区 |
| 14 | 底部面板与状态栏 | 终端/问题/测试/输出/轨迹、状态栏 |
| 15 | 虚拟文档 tab | 交付报告、Task DAG、工程画像 |
| 16 | 切换与清理 | 挂载点替换、删除旧实现、回归验证 |

任务 1-8 为 Rust 侧，可独立测试；9-15 为前端，依赖 1-7 的命令契约；16 收尾。

---

### Task 1: Rust 持久化层

**Files:**
- Create: `src-tauri/src/coding/mod.rs`
- Create: `src-tauri/src/coding/store.rs`
- Modify: `src-tauri/src/lib.rs`（在 `mod coding_workspace;` 附近加 `mod coding;`）

**Interfaces:**
- Consumes: `crate::paths::echo_agent_home_dir()`
- Produces:
  - `coding::store::workspace_dir(root: &Path) -> PathBuf`
  - `coding::store::task_dir(root: &Path, task_id: &str) -> PathBuf`
  - `coding::store::read_json<T: DeserializeOwned>(path: &Path) -> Option<T>`
  - `coding::store::write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String>`
  - `coding::store::append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), String>`
  - `coding::store::read_jsonl<T: DeserializeOwned>(path: &Path) -> Vec<T>`

目录布局：`<home>/coding/<workspace-hash>/tasks.json`，`<home>/coding/<workspace-hash>/<task-id>/{task.json,changeset.json,verifications.jsonl,diagnostics.jsonl,repairs.jsonl,evidence.jsonl}`。`workspace-hash` 用 `sha2::Sha256` 对规范化后的绝对路径取前 16 位十六进制（`sha2` 已在依赖中）。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/store.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        id: String,
        count: u32,
    }

    #[test]
    fn workspace_hash_is_stable_and_path_scoped() {
        let a = workspace_dir(Path::new("/tmp/repo-a"));
        let b = workspace_dir(Path::new("/tmp/repo-b"));
        assert_ne!(a, b);
        assert_eq!(a, workspace_dir(Path::new("/tmp/repo-a")));
    }

    #[test]
    fn json_roundtrip_and_missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("coding-store-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.json");
        assert!(read_json::<Sample>(&path).is_none());
        let value = Sample { id: "t1".into(), count: 3 };
        write_json(&path, &value).unwrap();
        assert_eq!(read_json::<Sample>(&path), Some(value));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jsonl_appends_in_order_and_skips_corrupt_lines() {
        let dir = std::env::temp_dir().join(format!("coding-store-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        append_jsonl(&path, &Sample { id: "a".into(), count: 1 }).unwrap();
        append_jsonl(&path, &Sample { id: "b".into(), count: 2 }).unwrap();
        std::fs::write(
            &path,
            format!("{}\n{{bad json}}\n", std::fs::read_to_string(&path).unwrap().trim()),
        )
        .unwrap();
        let items: Vec<Sample> = read_jsonl(&path);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[1].id, "b");
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::store`
Expected: 编译失败，提示 `workspace_dir` / `read_json` 等未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/mod.rs`：

```rust
//! Coding Agent workbench backend: task persistence, orchestration,
//! verification, diagnostics and delivery. Kept separate from the legacy
//! `coding_workspace` module so the workbench owns its own state.

pub mod store;
```

`src-tauri/src/coding/store.rs`：

```rust
//! File-backed persistence for coding tasks. Mirrors the JSON/JSONL layout
//! already used by `sessions.rs` instead of introducing a database.

use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

/// Per-workspace state root, keyed by a hash of the canonical repository path
/// so two checkouts of the same project never share task state.
pub fn workspace_dir(root: &Path) -> PathBuf {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    crate::paths::echo_agent_home_dir().join("coding").join(hash)
}

pub fn task_dir(root: &Path, task_id: &str) -> PathBuf {
    workspace_dir(root).join(task_id)
}

pub fn tasks_index_path(root: &Path) -> PathBuf {
    workspace_dir(root).join("tasks.json")
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))
}

/// Read a JSON document, treating a missing or corrupt file as absent so a
/// damaged task file can never crash the workbench.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    ensure_parent(path)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| format!("序列化失败：{error}"))?;
    std::fs::write(path, bytes).map_err(|error| format!("写入失败：{error}"))
}

pub fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    ensure_parent(path)?;
    let line = serde_json::to_string(value).map_err(|error| format!("序列化失败：{error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("打开失败：{error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("写入失败：{error}"))
}

/// Read an append-only log, skipping lines that failed to serialize or were
/// truncated by an interrupted write.
pub fn read_jsonl<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
```

`src-tauri/src/lib.rs`：在 `mod coding_workspace;` 上一行插入 `mod coding;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::store`
Expected: 3 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增代码工作台的任务持久化层

代码开发功能此前把任务状态存在 localStorage，需要两级降级裁剪才能绕开配额限制，且快照按仓库路径单值存储，导致一个仓库只能存在一个开发任务、清理浏览器缓存即丢失全部进度。改为在后端以文件持久化，沿用 sessions.rs 既有的 JSON/JSONL 布局，不引入数据库依赖。

- 新增 coding/store.rs，提供按仓库路径哈希隔离的状态目录与 JSON/JSONL 读写
- 损坏或缺失的文件按不存在处理，单行损坏的日志跳过该行，避免影响工作台启动
- 验证：cargo test coding::store 三个用例通过，覆盖哈希隔离、JSON 往返、日志追加与损坏行跳过
EOF
```

---

### Task 2: Rust 任务管理

**Files:**
- Create: `src-tauri/src/coding/task.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod task;`）
- Modify: `src-tauri/src/lib.rs`（注册 5 个命令）

**Interfaces:**
- Consumes: `coding::store::{tasks_index_path, task_dir, read_json, write_json}`
- Produces:
  - `TaskPhase` 枚举：`Idle | Planning | Implementing | Verifying | Diagnosing | Repairing | Gating | Delivered | Blocked`
  - `CodingTask { id, name, requirement, phase, acceptance_criteria, task_nodes, plan_required, model_id, created_at, updated_at, session_id }`
  - `AcceptanceCriterion { id, content, satisfied, evidence }`
  - `TaskNode { id, content, dependencies, related_files, status, priority }`
  - `coding::task::load(root,&str) -> Option<CodingTask>`
  - `coding::task::save(root,&CodingTask) -> Result<(),String>`
  - 命令：`coding_task_list`、`coding_task_create`、`coding_task_get`、`coding_task_delete`、`coding_task_rename`

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/task.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-task-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_multiple_tasks_per_workspace() {
        let root = temp_root();
        let first = create_task(&root, "重构登录", "把登录改成 OIDC").unwrap();
        let second = create_task(&root, "修复导出", "导出乱码").unwrap();
        assert_ne!(first.id, second.id);
        let list = list_tasks(&root);
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|task| task.name == "重构登录"));
        assert!(list.iter().any(|task| task.name == "修复导出"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn task_survives_reload_with_phase_and_criteria() {
        let root = temp_root();
        let mut task = create_task(&root, "重构登录", "把登录改成 OIDC").unwrap();
        task.phase = TaskPhase::Verifying;
        task.acceptance_criteria = vec![AcceptanceCriterion {
            id: "ac1".into(),
            content: "登录流程可用".into(),
            satisfied: false,
            evidence: Vec::new(),
        }];
        save(&root, &task).unwrap();
        let reloaded = load(&root, &task.id).unwrap();
        assert_eq!(reloaded.phase, TaskPhase::Verifying);
        assert_eq!(reloaded.acceptance_criteria.len(), 1);
        assert_eq!(reloaded.acceptance_criteria[0].content, "登录流程可用");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_task_from_index_and_disk() {
        let root = temp_root();
        let task = create_task(&root, "重构登录", "需求").unwrap();
        let dir = crate::coding::store::task_dir(&root, &task.id);
        assert!(dir.exists());
        delete_task(&root, &task.id).unwrap();
        assert!(list_tasks(&root).is_empty());
        assert!(!dir.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_keeps_id_and_updates_index() {
        let root = temp_root();
        let task = create_task(&root, "旧名", "需求").unwrap();
        rename_task(&root, &task.id, "新名").unwrap();
        let list = list_tasks(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
        assert_eq!(list[0].name, "新名");
        std::fs::remove_dir_all(&root).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::task`
Expected: 编译失败，`create_task` / `TaskPhase` 等未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/task.rs`：

```rust
//! Coding task lifecycle. A workspace can hold several concurrent tasks; each
//! owns its requirement, acceptance criteria, plan and phase, and survives a
//! restart so an interrupted run can be resumed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::store;
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Idle,
    Planning,
    Implementing,
    Verifying,
    Diagnosing,
    Repairing,
    Gating,
    Delivered,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TaskNodeStatus {
    Pending,
    Running,
    Success,
    Failed,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCriterion {
    pub id: String,
    pub content: String,
    /// Only set by the delivery layer from real evidence, never self-reported.
    pub satisfied: bool,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskNode {
    pub id: String,
    pub content: String,
    pub dependencies: Vec<String>,
    pub related_files: Vec<String>,
    pub status: TaskNodeStatus,
    pub priority: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodingTask {
    pub id: String,
    pub name: String,
    pub requirement: String,
    pub phase: TaskPhase,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub task_nodes: Vec<TaskNode>,
    pub plan_required: bool,
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    pub phase: TaskPhase,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct TaskIndex {
    tasks: Vec<TaskSummary>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn task_path(root: &Path, task_id: &str) -> std::path::PathBuf {
    store::task_dir(root, task_id).join("task.json")
}

pub fn list_tasks(root: &Path) -> Vec<TaskSummary> {
    store::read_json::<TaskIndex>(&store::tasks_index_path(root))
        .unwrap_or_default()
        .tasks
}

fn write_index(root: &Path, tasks: Vec<TaskSummary>) -> Result<(), String> {
    store::write_json(&store::tasks_index_path(root), &TaskIndex { tasks })
}

/// Refresh this task's row in the index, keeping insertion order stable so the
/// task switcher does not reshuffle while a run is in progress.
fn upsert_index(root: &Path, task: &CodingTask) -> Result<(), String> {
    let mut tasks = list_tasks(root);
    let summary = TaskSummary {
        id: task.id.clone(),
        name: task.name.clone(),
        phase: task.phase,
        updated_at: task.updated_at.clone(),
    };
    match tasks.iter_mut().find(|entry| entry.id == task.id) {
        Some(entry) => *entry = summary,
        None => tasks.push(summary),
    }
    write_index(root, tasks)
}

pub fn load(root: &Path, task_id: &str) -> Option<CodingTask> {
    store::read_json(&task_path(root, task_id))
}

pub fn save(root: &Path, task: &CodingTask) -> Result<(), String> {
    let mut stored = task.clone();
    stored.updated_at = now();
    store::write_json(&task_path(root, &stored.id), &stored)?;
    upsert_index(root, &stored)
}

pub fn create_task(root: &Path, name: &str, requirement: &str) -> Result<CodingTask, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("任务名称不能为空".into());
    }
    let timestamp = now();
    let task = CodingTask {
        id: uuid::Uuid::now_v7().to_string(),
        name: trimmed.to_string(),
        requirement: requirement.trim().to_string(),
        phase: TaskPhase::Idle,
        acceptance_criteria: Vec::new(),
        task_nodes: Vec::new(),
        plan_required: false,
        model_id: None,
        session_id: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    save(root, &task)?;
    Ok(task)
}

pub fn delete_task(root: &Path, task_id: &str) -> Result<(), String> {
    let dir = store::task_dir(root, task_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|error| format!("删除任务目录失败：{error}"))?;
    }
    let remaining = list_tasks(root)
        .into_iter()
        .filter(|entry| entry.id != task_id)
        .collect();
    write_index(root, remaining)
}

pub fn rename_task(root: &Path, task_id: &str, name: &str) -> Result<CodingTask, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("任务名称不能为空".into());
    }
    let mut task = load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    task.name = trimmed.to_string();
    save(root, &task)?;
    Ok(task)
}

#[tauri::command]
pub async fn coding_task_list(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<Vec<TaskSummary>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || list_tasks(&root))
        .await
        .map_err(|error| format!("读取任务列表失败：{error}"))
}

#[tauri::command]
pub async fn coding_task_create(
    access: State<'_, FilesystemAccess>,
    root: String,
    name: String,
    requirement: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || create_task(&root, &name, &requirement))
        .await
        .map_err(|error| format!("创建任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_get(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Option<CodingTask>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || load(&root, &task_id))
        .await
        .map_err(|error| format!("读取任务失败：{error}"))
}

#[tauri::command]
pub async fn coding_task_delete(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || delete_task(&root, &task_id))
        .await
        .map_err(|error| format!("删除任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_rename(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    name: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || rename_task(&root, &task_id, &name))
        .await
        .map_err(|error| format!("重命名任务失败：{error}"))?
}
```

`src-tauri/src/coding/mod.rs` 加一行 `pub mod task;`。

`src-tauri/src/lib.rs` 的 `invoke_handler` 列表里，在 `coding_workspace::coding_analyze_workspace,` 之前插入：

```rust
            coding::task::coding_task_list,
            coding::task::coding_task_create,
            coding::task::coding_task_get,
            coding::task::coding_task_delete,
            coding::task::coding_task_rename,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::task`
Expected: 4 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增代码工作台的多任务管理

工作台此前没有任务概念，开发状态直接绑定在仓库路径上，用户无法在同一个仓库里保留多个开发任务，也无法在中断后从原任务继续。本次引入结构化的任务对象，把需求、验收标准、任务节点和阶段一起持久化，为后续编排与恢复提供基础。

- 新增 coding/task.rs，定义任务阶段、验收标准与任务节点模型
- 支持同一仓库内多任务并存，索引与任务详情分离存储，重命名保持任务标识不变
- 提供任务列表、创建、读取、删除、重命名五个命令，全部经工作区路径校验并在阻塞线程池中执行文件读写
- 验证：cargo test coding::task 四个用例通过，覆盖多任务并存、重载后阶段与验收标准保持、删除清理磁盘、重命名更新索引
EOF
```

---

### Task 3: Rust ChangeSet 与任务回滚

**Files:**
- Create: `src-tauri/src/coding/changeset.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod changeset;`）
- Modify: `src-tauri/src/lib.rs`（注册 4 个命令）

**Interfaces:**
- Consumes: `coding::store::{task_dir, read_json, write_json}`、`coding::task::load`
- Produces:
  - `ChangeKind` 枚举：`Added | Modified | Deleted | Renamed`
  - `FileChange { path, kind, added, removed, baseline_content, pre_existing }`
  - `ChangeSet { task_id, baseline_files, changes, created_at }`
  - `coding::changeset::load(root,&str) -> ChangeSet`
  - `coding::changeset::capture_baseline(root,&str,Vec<String>) -> Result<ChangeSet,String>`
  - `coding::changeset::record_change(root,&str,FileChange) -> Result<ChangeSet,String>`
  - `coding::changeset::rollback(root,&str) -> Result<Vec<String>,String>`
  - 命令：`coding_changeset_get`、`coding_changeset_capture_baseline`、`coding_changeset_discard_file`、`coding_task_rollback`

关键语义：`pre_existing` 标记任务开始前就已存在的未提交变更，回滚时**必须跳过**这些文件（清单 1.9、5.21、12.9 用户改动保护）。回滚用 `baseline_content` 还原，新建文件直接删除。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/changeset.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-cs-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_changes_and_accumulates_line_counts() {
        let root = temp_root();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 10,
                removed: 2,
                baseline_content: Some("old".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/b.ts".into(),
                kind: ChangeKind::Added,
                added: 30,
                removed: 0,
                baseline_content: None,
                pre_existing: false,
            },
        )
        .unwrap();
        assert_eq!(set.changes.len(), 2);
        assert_eq!(set.total_added(), 40);
        assert_eq!(set.total_removed(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn re_recording_same_file_replaces_not_duplicates() {
        let root = temp_root();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 5,
                removed: 1,
                baseline_content: Some("v1".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 8,
                removed: 3,
                baseline_content: Some("should-not-overwrite".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        assert_eq!(set.changes.len(), 1);
        assert_eq!(set.changes[0].added, 8);
        // The first baseline must win; it is the only content that can restore
        // the file to its pre-task state.
        assert_eq!(set.changes[0].baseline_content.as_deref(), Some("v1"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rollback_restores_modified_deletes_added_and_skips_user_changes() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/modified.ts"), "agent version").unwrap();
        std::fs::write(root.join("src/created.ts"), "agent created").unwrap();
        std::fs::write(root.join("src/user.ts"), "user edited").unwrap();

        for change in [
            FileChange {
                path: "src/modified.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 1,
                baseline_content: Some("original version".into()),
                pre_existing: false,
            },
            FileChange {
                path: "src/created.ts".into(),
                kind: ChangeKind::Added,
                added: 1,
                removed: 0,
                baseline_content: None,
                pre_existing: false,
            },
            FileChange {
                path: "src/user.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 0,
                baseline_content: Some("never restore this".into()),
                pre_existing: true,
            },
        ] {
            record_change(&root, "task-1", change).unwrap();
        }

        let restored = rollback(&root, "task-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/modified.ts")).unwrap(),
            "original version"
        );
        assert!(!root.join("src/created.ts").exists());
        // A pre-existing user change is never touched by task rollback.
        assert_eq!(
            std::fs::read_to_string(root.join("src/user.ts")).unwrap(),
            "user edited"
        );
        assert_eq!(restored.len(), 2);
        assert!(load(&root, "task-1").changes.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn baseline_marks_pre_existing_dirty_files() {
        let root = temp_root();
        let set = capture_baseline(
            &root,
            "task-1",
            vec!["src/dirty.ts".to_string(), "src/other.ts".to_string()],
        )
        .unwrap();
        assert_eq!(set.baseline_files.len(), 2);
        assert!(set.is_pre_existing("src/dirty.ts"));
        assert!(!set.is_pre_existing("src/fresh.ts"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mark_reviewed_is_idempotent() {
        let root = temp_root();
        mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        let set = mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        assert_eq!(set.reviewed_files, vec!["src/a.ts".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_file_restores_one_file_and_drops_its_record() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "agent").unwrap();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 1,
                baseline_content: Some("original".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = discard_file(&root, "task-1", "src/a.ts").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/a.ts")).unwrap(), "original");
        assert!(set.changes.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::changeset`
Expected: 编译失败，`FileChange` / `record_change` / `rollback` 等未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/changeset.rs`：

```rust
//! Per-task change set. Records every file the Agent touched together with the
//! content it had before the task started, which is what makes a one-click
//! task rollback possible without reaching for Git history.
//!
//! Files that were already dirty when the task began are marked `pre_existing`
//! and are never restored or deleted by a rollback — the user's own uncommitted
//! work must survive any Agent operation.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::store;
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path, always forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    pub added: u32,
    pub removed: u32,
    /// Content before this task modified the file; `None` for newly created
    /// files, which are deleted rather than restored on rollback.
    pub baseline_content: Option<String>,
    /// The file already had uncommitted edits before the task started.
    pub pre_existing: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub task_id: String,
    /// Paths that were dirty before the task started.
    pub baseline_files: Vec<String>,
    pub changes: Vec<FileChange>,
    pub created_at: String,
    /// Paths whose diff the user actually opened. The diff-review gate in
    /// Task 7 needs evidence of review, not merely the existence of a change.
    #[serde(default)]
    pub reviewed_files: Vec<String>,
}

impl ChangeSet {
    pub fn total_added(&self) -> u32 {
        self.changes.iter().map(|change| change.added).sum()
    }

    pub fn total_removed(&self) -> u32 {
        self.changes.iter().map(|change| change.removed).sum()
    }

    pub fn is_pre_existing(&self, path: &str) -> bool {
        self.baseline_files.iter().any(|entry| entry == path)
    }
}

/// Mark one file's diff as reviewed. Feeds the diff-review quality gate.
pub fn mark_reviewed(root: &Path, task_id: &str, path: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    if !set.reviewed_files.iter().any(|entry| entry == path) {
        set.reviewed_files.push(path.to_string());
        save(root, &set)?;
    }
    Ok(set)
}

fn changeset_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("changeset.json")
}

pub fn load(root: &Path, task_id: &str) -> ChangeSet {
    store::read_json(&changeset_path(root, task_id)).unwrap_or_else(|| ChangeSet {
        task_id: task_id.to_string(),
        baseline_files: Vec::new(),
        changes: Vec::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        reviewed_files: Vec::new(),
    })
}

fn save(root: &Path, set: &ChangeSet) -> Result<(), String> {
    store::write_json(&changeset_path(root, &set.task_id), set)
}

/// Reject paths that try to escape the workspace before any write or delete.
fn resolve_in_workspace(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains("..") || normalized.contains('\0') {
        return Err(format!("非法的工作区路径：{relative}"));
    }
    Ok(root.join(normalized))
}

pub fn capture_baseline(
    root: &Path,
    task_id: &str,
    dirty_files: Vec<String>,
) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    set.baseline_files = dirty_files;
    save(root, &set)?;
    Ok(set)
}

/// Record one file change. Re-recording the same path replaces its counters but
/// keeps the first baseline content, because only that snapshot can restore the
/// file to its pre-task state.
pub fn record_change(root: &Path, task_id: &str, change: FileChange) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    let pre_existing = change.pre_existing || set.is_pre_existing(&change.path);
    match set.changes.iter_mut().find(|entry| entry.path == change.path) {
        Some(existing) => {
            existing.kind = change.kind;
            existing.added = change.added;
            existing.removed = change.removed;
            existing.pre_existing = pre_existing;
            if existing.baseline_content.is_none() {
                existing.baseline_content = change.baseline_content;
            }
        }
        None => set.changes.push(FileChange {
            pre_existing,
            ..change
        }),
    }
    save(root, &set)?;
    Ok(set)
}

fn restore_one(root: &Path, change: &FileChange) -> Result<(), String> {
    let target = resolve_in_workspace(root, &change.path)?;
    match &change.baseline_content {
        Some(content) => {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("无法创建目录：{error}"))?;
            }
            std::fs::write(&target, content)
                .map_err(|error| format!("还原 {} 失败：{error}", change.path))
        }
        None => {
            if target.exists() {
                std::fs::remove_file(&target)
                    .map_err(|error| format!("删除 {} 失败：{error}", change.path))?;
            }
            Ok(())
        }
    }
}

/// Undo every change this task made, skipping files the user had already
/// modified. Returns the paths that were actually restored or deleted.
pub fn rollback(root: &Path, task_id: &str) -> Result<Vec<String>, String> {
    let mut set = load(root, task_id);
    let mut restored = Vec::new();
    for change in &set.changes {
        if change.pre_existing {
            continue;
        }
        restore_one(root, change)?;
        restored.push(change.path.clone());
    }
    set.changes.retain(|change| change.pre_existing);
    save(root, &set)?;
    Ok(restored)
}

pub fn discard_file(root: &Path, task_id: &str, path: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    let Some(index) = set.changes.iter().position(|change| change.path == path) else {
        return Ok(set);
    };
    if set.changes[index].pre_existing {
        return Err("该文件在任务开始前已有改动，不会被工作台丢弃".into());
    }
    restore_one(root, &set.changes[index])?;
    set.changes.remove(index);
    save(root, &set)?;
    Ok(set)
}

#[tauri::command]
pub async fn coding_changeset_get(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || load(&root, &task_id))
        .await
        .map_err(|error| format!("读取变更集失败：{error}"))
}

#[tauri::command]
pub async fn coding_changeset_capture_baseline(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    dirty_files: Vec<String>,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || capture_baseline(&root, &task_id, dirty_files))
        .await
        .map_err(|error| format!("记录基线失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_discard_file(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || discard_file(&root, &task_id, &path))
        .await
        .map_err(|error| format!("丢弃文件改动失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_rollback(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<String>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || rollback(&root, &task_id))
        .await
        .map_err(|error| format!("回滚任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_mark_reviewed(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || mark_reviewed(&root, &task_id, &path))
        .await
        .map_err(|error| format!("标记已审阅失败：{error}"))?
}
```

`src-tauri/src/coding/mod.rs` 加 `pub mod changeset;`。

`src-tauri/src/lib.rs` 的 `invoke_handler` 里，紧跟 Task 2 的五个命令之后插入：

```rust
            coding::changeset::coding_changeset_get,
            coding::changeset::coding_changeset_capture_baseline,
            coding::changeset::coding_changeset_record_change,
            coding::changeset::coding_changeset_discard_file,
            coding::changeset::coding_changeset_mark_reviewed,
            coding::changeset::coding_task_rollback,
```

`record_change` 还需要一个对应的命令 `coding_changeset_record_change`（参数 `root`、`task_id`、`change: FileChange`），供前端在编辑落盘时记录变更，否则该函数在第一期没有调用方：

```rust
/// Record one file the Agent (or the user's own editor) just changed. The
/// frontend calls this as edits land so the change set stays authoritative
/// without polling Git.
#[tauri::command]
pub async fn coding_changeset_record_change(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    change: FileChange,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || record_change(&root, &task_id, change))
        .await
        .map_err(|error| format!("记录文件变更失败：{error}"))?
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::changeset`
Expected: 5 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增任务级变更集与一键回滚

工作台此前只能读取 Git 工作区状态，无法区分哪些改动来自本轮任务、哪些是用户任务开始前就有的未提交修改，因此既无法按任务回滚，也无法保证回滚不破坏用户自己的工作。本次为每个任务建立独立变更集，并记录改动前的文件内容作为还原依据。

- 新增 coding/changeset.rs，按任务记录文件变更类型、增删行数与改动前内容
- 重复记录同一文件时保留首次基线内容，确保还原目标始终是任务开始前的状态
- 回滚跳过任务开始前已存在改动的文件，修改类还原内容、新建类直接删除
- 支持单文件丢弃，并拒绝丢弃任务开始前已有改动的文件
- 写入与删除前校验路径未越出工作区
- 验证：cargo test coding::changeset 五个用例通过，覆盖行数累计、重复记录保留首次基线、回滚三类文件的差异处理、基线标记、单文件丢弃
EOF
```

---

### Task 4: Rust 验证引擎

**Files:**
- Create: `src-tauri/src/coding/verification.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod verification;`）
- Modify: `src-tauri/src/lib.rs`（注册 3 个命令）

**Interfaces:**
- Consumes: `coding::store::{task_dir, append_jsonl, read_jsonl}`
- Produces:
  - `VerificationKind` 枚举：`Build | Lint | TypeCheck | Test | Custom`
  - `VerificationStatus` 枚举：`Running | Passed | Failed | TimedOut | Cancelled`
  - `TestSummary { total, passed, failed, skipped }`
  - `VerificationRecord { id, task_id, kind, command, status, exit_code, stdout, stderr, duration_ms, started_at, finished_at, test_summary, structured }`
  - `coding::verification::detect_commands(root) -> Vec<DetectedCommand>`
  - `coding::verification::parse_test_output(&str) -> Option<TestSummary>`
  - `coding::verification::run(app,processes,root,task_id,kind,command,timeout) -> Result<VerificationRecord,String>`
  - 命令：`coding_verification_list`、`coding_verification_run`、`coding_verification_cancel`

关键语义：`status` 只由退出码决定（`exit_code == 0` → Passed）。`test_summary` 由输出解析得出，解析失败时置 `None` 并把 `structured` 标为 `false`，UI 据此标注「未结构化解析」。这是设计文档风险表里的降级策略。

命令识别覆盖：`package.json` 的 scripts（build/lint/typecheck/test）、`Cargo.toml`（cargo build/clippy/test）、`pom.xml`（mvn compile/test）、`build.gradle`（gradle build/test）、`pyproject.toml`（pytest/mypy/ruff）、`go.mod`（go build/vet/test）。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/verification.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-verify-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_npm_scripts_by_kind() {
        let root = temp_root();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"build":"tsc --noEmit && vite build","lint":"eslint .","test":"vitest run"}}"#,
        )
        .unwrap();
        let detected = detect_commands(&root);
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Build && entry.command.contains("build")));
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Lint && entry.command.contains("lint")));
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Test && entry.command.contains("test")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detects_cargo_and_maven_projects() {
        let root = temp_root();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        let detected = detect_commands(&root);
        assert!(detected.iter().any(|entry| entry.command == "cargo build"));
        assert!(detected.iter().any(|entry| entry.command == "cargo test"));
        std::fs::remove_dir_all(&root).ok();

        let maven = temp_root();
        std::fs::write(maven.join("pom.xml"), "<project></project>").unwrap();
        let detected = detect_commands(&maven);
        assert!(detected.iter().any(|entry| entry.command.starts_with("mvn")));
        std::fs::remove_dir_all(&maven).ok();
    }

    #[test]
    fn parses_vitest_summary() {
        let summary = parse_test_output("Test Files  2 passed (2)\n Tests  42 passed | 1 skipped (43)")
            .expect("vitest output should parse");
        assert_eq!(summary.passed, 42);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.failed, 0);
    }

    #[test]
    fn parses_pytest_and_junit_and_cargo_summaries() {
        let pytest = parse_test_output("=== 3 failed, 12 passed, 2 skipped in 4.21s ===").unwrap();
        assert_eq!(pytest.failed, 3);
        assert_eq!(pytest.passed, 12);
        assert_eq!(pytest.skipped, 2);

        let junit = parse_test_output("Tests run: 24, Failures: 2, Errors: 1, Skipped: 3").unwrap();
        assert_eq!(junit.total, 24);
        assert_eq!(junit.failed, 3);
        assert_eq!(junit.skipped, 3);

        let cargo =
            parse_test_output("test result: FAILED. 8 passed; 2 failed; 1 ignored").unwrap();
        assert_eq!(cargo.passed, 8);
        assert_eq!(cargo.failed, 2);
        assert_eq!(cargo.skipped, 1);
    }

    #[test]
    fn unparseable_output_yields_none() {
        assert!(parse_test_output("Compiling demo v0.1.0\nFinished in 3s").is_none());
    }

    #[test]
    fn status_follows_exit_code_not_output_text() {
        // Output that reads like success must not override a non-zero exit code.
        let record = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            Some(1),
            "All tests passed!".into(),
            String::new(),
            120,
            false,
            false,
        );
        assert_eq!(record.status, VerificationStatus::Failed);

        let passing = record_from_parts(
            "task-1",
            VerificationKind::Build,
            "pnpm build",
            Some(0),
            String::new(),
            "warning: unused import".into(),
            80,
            false,
            false,
        );
        assert_eq!(passing.status, VerificationStatus::Passed);
    }

    #[test]
    fn timeout_and_cancel_are_distinct_from_failure() {
        let timed_out = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            300_000,
            true,
            false,
        );
        assert_eq!(timed_out.status, VerificationStatus::TimedOut);

        let cancelled = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            500,
            false,
            true,
        );
        assert_eq!(cancelled.status, VerificationStatus::Cancelled);
    }

    #[test]
    fn records_append_and_reload_in_order() {
        let root = temp_root();
        for index in 0..3 {
            let record = record_from_parts(
                "task-1",
                VerificationKind::Test,
                &format!("cmd-{index}"),
                Some(0),
                String::new(),
                String::new(),
                10,
                false,
                false,
            );
            append_record(&root, &record).unwrap();
        }
        let records = list_records(&root, "task-1");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].command, "cmd-0");
        assert_eq!(records[2].command, "cmd-2");
        std::fs::remove_dir_all(&root).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::verification`
Expected: 编译失败，`detect_commands` / `parse_test_output` / `record_from_parts` 等未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/verification.rs`：

```rust
//! Verification engine: detect a project's real build / lint / type-check /
//! test commands, run them, and turn their output into structured records.
//!
//! A verification's pass/fail verdict comes from the process exit code alone.
//! Output parsing only enriches a record with a test summary; when parsing
//! fails the record is still trustworthy, just marked as unstructured.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::coding::store;
use crate::coding_workspace::{high_risk_command_reason, CodingProcesses};
use crate::shell_fs::FilesystemAccess;

const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 300;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum VerificationKind {
    Build,
    Lint,
    TypeCheck,
    Test,
    Custom,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Running,
    Passed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestSummary {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCommand {
    pub kind: VerificationKind,
    pub command: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub id: String,
    pub task_id: String,
    pub kind: VerificationKind,
    pub command: String,
    pub status: VerificationStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub started_at: String,
    pub finished_at: String,
    pub test_summary: Option<TestSummary>,
    /// False when the output could not be parsed into a summary, so the UI can
    /// say so instead of implying a clean structured result.
    pub structured: bool,
}

fn records_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("verifications.jsonl")
}

pub fn append_record(root: &Path, record: &VerificationRecord) -> Result<(), String> {
    store::append_jsonl(&records_path(root, &record.task_id), record)
}

pub fn list_records(root: &Path, task_id: &str) -> Vec<VerificationRecord> {
    store::read_jsonl(&records_path(root, task_id))
}

fn label_for(kind: VerificationKind) -> &'static str {
    match kind {
        VerificationKind::Build => "构建",
        VerificationKind::Lint => "静态检查",
        VerificationKind::TypeCheck => "类型检查",
        VerificationKind::Test => "测试",
        VerificationKind::Custom => "命令",
    }
}

/// Detect the project's real verification commands from its manifests. Only
/// commands that actually exist are returned, so the orchestrator never invents
/// a script the project does not define.
pub fn detect_commands(root: &Path) -> Vec<DetectedCommand> {
    let mut detected = Vec::new();
    let mut push = |kind: VerificationKind, command: String| {
        if !detected
            .iter()
            .any(|entry: &DetectedCommand| entry.command == command)
        {
            detected.push(DetectedCommand {
                kind,
                label: label_for(kind).to_string(),
                command,
            });
        }
    };

    if let Some(manifest) = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        let runner = if root.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if root.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm run"
        };
        let scripts = manifest.get("scripts").and_then(|value| value.as_object());
        if let Some(scripts) = scripts {
            for (name, kind) in [
                ("build", VerificationKind::Build),
                ("lint", VerificationKind::Lint),
                ("typecheck", VerificationKind::TypeCheck),
                ("type-check", VerificationKind::TypeCheck),
                ("tsc", VerificationKind::TypeCheck),
                ("test", VerificationKind::Test),
            ] {
                if scripts.contains_key(name) {
                    push(kind, format!("{runner} {name}"));
                }
            }
        }
    }

    if root.join("Cargo.toml").exists() {
        push(VerificationKind::Build, "cargo build".into());
        push(VerificationKind::Lint, "cargo clippy".into());
        push(VerificationKind::Test, "cargo test".into());
    }
    if root.join("pom.xml").exists() {
        push(VerificationKind::Build, "mvn -B compile".into());
        push(VerificationKind::Test, "mvn -B test".into());
    }
    if root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        push(VerificationKind::Build, "gradle build".into());
        push(VerificationKind::Test, "gradle test".into());
    }
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        push(VerificationKind::Test, "pytest".into());
        if root.join("mypy.ini").exists() || root.join("pyproject.toml").exists() {
            push(VerificationKind::TypeCheck, "mypy .".into());
        }
    }
    if root.join("go.mod").exists() {
        push(VerificationKind::Build, "go build ./...".into());
        push(VerificationKind::Lint, "go vet ./...".into());
        push(VerificationKind::Test, "go test ./...".into());
    }
    detected
}

fn capture(text: &str, pattern: &str, group: usize) -> Option<u32> {
    regex::Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(group)?
        .as_str()
        .parse()
        .ok()
}

/// Parse a test runner's summary line. Returns `None` when no known shape is
/// present; callers must not treat that as zero tests.
pub fn parse_test_output(output: &str) -> Option<TestSummary> {
    // JUnit / Maven: "Tests run: 24, Failures: 2, Errors: 1, Skipped: 3"
    if let Some(total) = capture(output, r"Tests run:\s*(\d+)", 1) {
        let failures = capture(output, r"Failures:\s*(\d+)", 1).unwrap_or(0);
        let errors = capture(output, r"Errors:\s*(\d+)", 1).unwrap_or(0);
        let skipped = capture(output, r"Skipped:\s*(\d+)", 1).unwrap_or(0);
        let failed = failures + errors;
        return Some(TestSummary {
            total,
            failed,
            skipped,
            passed: total.saturating_sub(failed + skipped),
        });
    }
    // cargo: "test result: FAILED. 8 passed; 2 failed; 1 ignored"
    if output.contains("test result:") {
        let passed = capture(output, r"(\d+)\s+passed", 1).unwrap_or(0);
        let failed = capture(output, r"(\d+)\s+failed", 1).unwrap_or(0);
        let skipped = capture(output, r"(\d+)\s+ignored", 1).unwrap_or(0);
        return Some(TestSummary {
            total: passed + failed + skipped,
            passed,
            failed,
            skipped,
        });
    }
    // pytest: "=== 3 failed, 12 passed, 2 skipped in 4.21s ==="
    if let Some(passed) = capture(output, r"(\d+)\s+passed", 1) {
        let failed = capture(output, r"(\d+)\s+failed", 1).unwrap_or(0);
        let skipped = capture(output, r"(\d+)\s+skipped", 1).unwrap_or(0);
        return Some(TestSummary {
            total: passed + failed + skipped,
            passed,
            failed,
            skipped,
        });
    }
    None
}

/// Build a record from finished process parts. Extracted so the exit-code-only
/// verdict rule is unit-testable without spawning a process.
#[allow(clippy::too_many_arguments)]
pub fn record_from_parts(
    task_id: &str,
    kind: VerificationKind,
    command: &str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    cancelled: bool,
) -> VerificationRecord {
    let status = if cancelled {
        VerificationStatus::Cancelled
    } else if timed_out {
        VerificationStatus::TimedOut
    } else if exit_code == Some(0) {
        VerificationStatus::Passed
    } else {
        VerificationStatus::Failed
    };
    let combined = format!("{stdout}\n{stderr}");
    let test_summary = matches!(kind, VerificationKind::Test)
        .then(|| parse_test_output(&combined))
        .flatten();
    VerificationRecord {
        id: uuid::Uuid::now_v7().to_string(),
        task_id: task_id.to_string(),
        kind,
        command: command.to_string(),
        status,
        exit_code,
        stdout,
        stderr,
        duration_ms,
        started_at: chrono::Utc::now().to_rfc3339(),
        finished_at: chrono::Utc::now().to_rfc3339(),
        structured: test_summary.is_some(),
        test_summary,
    }
}

fn truncate_output(mut text: String) -> String {
    if text.len() > MAX_OUTPUT_BYTES {
        let tail = text.split_off(text.len() - MAX_OUTPUT_BYTES);
        return format!("…较早输出已省略…\n{tail}");
    }
    text
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerificationChunk {
    run_id: String,
    stream: &'static str,
    chunk: String,
}

/// Run one verification command inside the workspace. Streams output to the UI
/// and honours the same native high-risk command policy as the rest of the app.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    app: AppHandle,
    processes: &CodingProcesses,
    root: PathBuf,
    task_id: String,
    kind: VerificationKind,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<VerificationRecord, String> {
    let command_text = command.trim().to_string();
    if command_text.is_empty() {
        return Err("命令不能为空".into());
    }
    if let Some(reason) = high_risk_command_reason(&command_text, &root) {
        return Err(format!("命令被原生安全策略拒绝：{reason}"));
    }
    let run_id = uuid::Uuid::now_v7().to_string();
    let cancellation = CancellationToken::new();
    processes.register(&run_id, cancellation.clone())?;

    let mut builder = if cfg!(target_os = "windows") {
        let mut builder = Command::new("cmd");
        builder.args(["/D", "/S", "/C", &command_text]);
        builder
    } else {
        let mut builder = Command::new("sh");
        builder.args(["-lc", &command_text]);
        builder
    };
    builder
        .current_dir(&root)
        .env("CI", "true")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    builder.process_group(0);

    let started = Instant::now();
    let mut child = builder
        .spawn()
        .map_err(|error| format!("无法执行命令：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法捕获标准输出")?;
    let stderr = child.stderr.take().ok_or("无法捕获错误输出")?;

    let collect = |reader: tokio::process::ChildStdout| {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            let mut buffer = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "coding://verification-output",
                    VerificationChunk {
                        run_id: run_id.clone(),
                        stream: "stdout",
                        chunk: format!("{line}\n"),
                    },
                );
                buffer.push_str(&line);
                buffer.push('\n');
            }
            buffer
        })
    };
    let stdout_task = collect(stdout);
    let stderr_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut buffer = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "coding://verification-output",
                    VerificationChunk {
                        run_id: run_id.clone(),
                        stream: "stderr",
                        chunk: format!("{line}\n"),
                    },
                );
                buffer.push_str(&line);
                buffer.push('\n');
            }
            buffer
        })
    };

    let timeout = std::time::Duration::from_secs(
        timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(5, 1_800),
    );
    let mut timed_out = false;
    let mut cancelled = false;
    let exit_status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = tokio::time::sleep(timeout) => {
            timed_out = true;
            let _ = child.start_kill();
            child.wait().await.ok()
        }
        _ = cancellation.cancelled() => {
            cancelled = true;
            let _ = child.start_kill();
            child.wait().await.ok()
        }
    };

    processes.unregister(&run_id);
    let stdout_text = truncate_output(stdout_task.await.unwrap_or_default());
    let stderr_text = truncate_output(stderr_task.await.unwrap_or_default());
    let record = record_from_parts(
        &task_id,
        kind,
        &command_text,
        exit_status.and_then(|status| status.code()),
        stdout_text,
        stderr_text,
        started.elapsed().as_millis() as u64,
        timed_out,
        cancelled,
    );
    let write_root = root.clone();
    let write_record = record.clone();
    tokio::task::spawn_blocking(move || append_record(&write_root, &write_record))
        .await
        .map_err(|error| format!("写入验证记录失败：{error}"))??;
    let _ = app.emit("coding://verification-updated", &record);
    Ok(record)
}

#[tauri::command]
pub async fn coding_verification_list(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<VerificationRecord>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || list_records(&root, &task_id))
        .await
        .map_err(|error| format!("读取验证记录失败：{error}"))
}

#[tauri::command]
pub async fn coding_verification_run(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    processes: State<'_, CodingProcesses>,
    root: String,
    task_id: String,
    kind: VerificationKind,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<VerificationRecord, String> {
    let root = access.require_workspace(&root)?;
    run(app, &processes, root, task_id, kind, command, timeout_secs).await
}

#[tauri::command]
pub async fn coding_verification_cancel(
    processes: State<'_, CodingProcesses>,
    run_id: String,
) -> Result<(), String> {
    processes.cancel(&run_id)
}
```

配套改造 `src-tauri/src/coding_workspace.rs`：

其一，把 `high_risk_command_reason`（当前在 `coding_workspace.rs:1690`，私有）改为公开，让验证引擎复用同一份高危命令策略而不是复制一套：

```rust
pub fn high_risk_command_reason(command: &str, workspace_root: &Path) -> Option<&'static str> {
```

其二，为 `CodingProcesses`（`coding_workspace.rs:184`，`commands` 字段私有）增加三个方法：

```rust
impl CodingProcesses {
    pub fn register(&self, run_id: &str, token: CancellationToken) -> Result<(), String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "命令运行状态已损坏".to_string())?;
        if commands.contains_key(run_id) {
            return Err("命令运行标识已存在".into());
        }
        commands.insert(run_id.to_string(), token);
        Ok(())
    }

    pub fn unregister(&self, run_id: &str) {
        if let Ok(mut commands) = self.commands.lock() {
            commands.remove(run_id);
        }
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        let commands = self
            .commands
            .lock()
            .map_err(|_| "命令运行状态已损坏".to_string())?;
        match commands.get(run_id) {
            Some(token) => {
                token.cancel();
                Ok(())
            }
            None => Err("命令已结束或不存在".into()),
        }
    }
}
```

`src-tauri/src/coding/mod.rs` 加 `pub mod verification;`。`lib.rs` 注册：

```rust
            coding::verification::coding_verification_list,
            coding::verification::coding_verification_run,
            coding::verification::coding_verification_cancel,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::verification`
Expected: 8 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/coding_workspace.rs src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增验证引擎并统一命令执行入口

工作台此前用两条路径执行命令：自己的 coding_run_command 与 Agent 的终端工具，结果靠正则从消息流里抽取再合并，两套超时和两套风险策略容易不一致；测试是否通过也部分依赖输出文本判断，模型自述「测试通过」时可能与真实退出码矛盾。本次建立统一的验证引擎，把判定权交给退出码。

- 新增 coding/verification.rs，从 package.json、Cargo.toml、pom.xml、build.gradle、pyproject.toml、go.mod 识别项目真实的构建、静态检查、类型检查与测试命令
- 验证结论只由进程退出码决定，超时与主动取消与失败区分为独立状态
- 解析 JUnit、cargo、pytest、vitest 四类测试摘要，解析失败时标记为未结构化而非当作零用例
- 输出按行流式推送到前端并限制留存大小，命令执行前经过原生高危命令策略
- 为 CodingProcesses 增加注册、注销与取消方法，作为唯一的命令取消入口
- 验证：cargo test coding::verification 八个用例通过，覆盖命令识别、四种测试摘要解析、无法解析时返回空、退出码优先于输出文本、超时与取消状态区分、记录顺序追加
EOF
```

---

### Task 5: Rust 诊断中心

**Files:**
- Create: `src-tauri/src/coding/diagnostics.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod diagnostics;`）
- Modify: `src-tauri/src/lib.rs`（注册 1 个命令）

**Interfaces:**
- Consumes: `coding::store::{task_dir, append_jsonl, read_jsonl}`、`coding::verification::VerificationRecord`
- Produces:
  - `ProblemKind` 枚举：`Compile | Syntax | Type | Lint | TestFailure | Runtime | Dependency | Configuration`
  - `ProblemSeverity` 枚举：`Error | Warning`
  - `Problem { id, kind, severity, message, file, line, column, symbol, source_command, fingerprint }`
  - `coding::diagnostics::parse_record(&VerificationRecord) -> Vec<Problem>`
  - `coding::diagnostics::classify(&str) -> ProblemKind`
  - `coding::diagnostics::save_snapshot(root,&str,&[Problem]) -> Result<(),String>`
  - `coding::diagnostics::load_snapshot(root,&str) -> Vec<Problem>`
  - 命令：`coding_diagnostics_list`

关键语义：`fingerprint` 是 `kind + file + line + 规范化 message` 的哈希，用于修复引擎的重复错误检测（清单 9.11）和新错误检测（9.12）。规范化会剥掉行号外的可变数字与临时路径，保证同一问题跨轮次指纹稳定。

解析器覆盖：tsc、eslint（stylish）、cargo/rustc、javac/maven、pytest、mypy、go build/vet、Node 堆栈、npm/pip/maven 依赖错误。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/diagnostics.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::coding::verification::{record_from_parts, VerificationKind};

    fn record(kind: VerificationKind, stdout: &str, stderr: &str) -> VerificationRecord {
        record_from_parts(
            "task-1",
            kind,
            "cmd",
            Some(1),
            stdout.to_string(),
            stderr.to_string(),
            100,
            false,
            false,
        )
    }

    #[test]
    fn parses_typescript_errors_with_position() {
        let output = "src/auth.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
        let problems = parse_record(&record(VerificationKind::TypeCheck, output, ""));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].kind, ProblemKind::Type);
        assert_eq!(problems[0].file.as_deref(), Some("src/auth.ts"));
        assert_eq!(problems[0].line, Some(42));
        assert_eq!(problems[0].column, Some(17));
        assert!(problems[0].message.contains("TS2345"));
    }

    #[test]
    fn parses_eslint_stylish_block() {
        let output = "/repo/src/app.ts\n  12:5  error  'foo' is assigned a value but never used  no-unused-vars\n  20:1  warning  Missing semicolon  semi\n";
        let problems = parse_record(&record(VerificationKind::Lint, output, ""));
        assert_eq!(problems.len(), 2);
        assert_eq!(problems[0].kind, ProblemKind::Lint);
        assert_eq!(problems[0].severity, ProblemSeverity::Error);
        assert_eq!(problems[0].line, Some(12));
        assert_eq!(problems[1].severity, ProblemSeverity::Warning);
        assert_eq!(problems[1].line, Some(20));
    }

    #[test]
    fn parses_rustc_error_with_following_location_line() {
        let output = "error[E0308]: mismatched types\n  --> src/main.rs:10:22\n   |\n10 |     let x: u32 = \"a\";\n";
        let problems = parse_record(&record(VerificationKind::Build, "", output));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].kind, ProblemKind::Compile);
        assert_eq!(problems[0].file.as_deref(), Some("src/main.rs"));
        assert_eq!(problems[0].line, Some(10));
        assert_eq!(problems[0].column, Some(22));
    }

    #[test]
    fn parses_pytest_failure_with_test_symbol() {
        let output = "FAILED tests/test_auth.py::test_login_rejects_expired - AssertionError: expected 401";
        let problems = parse_record(&record(VerificationKind::Test, output, ""));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].kind, ProblemKind::TestFailure);
        assert_eq!(problems[0].file.as_deref(), Some("tests/test_auth.py"));
        assert_eq!(
            problems[0].symbol.as_deref(),
            Some("test_login_rejects_expired")
        );
    }

    #[test]
    fn parses_javac_and_mypy_and_go() {
        let javac = parse_record(&record(
            VerificationKind::Build,
            "/repo/src/Main.java:15: error: cannot find symbol",
            "",
        ));
        assert_eq!(javac[0].kind, ProblemKind::Compile);
        assert_eq!(javac[0].line, Some(15));

        let mypy = parse_record(&record(
            VerificationKind::TypeCheck,
            "app/models.py:8: error: Incompatible return value type",
            "",
        ));
        assert_eq!(mypy[0].kind, ProblemKind::Type);
        assert_eq!(mypy[0].line, Some(8));

        let go = parse_record(&record(
            VerificationKind::Build,
            "./handler.go:31:5: undefined: parseToken",
            "",
        ));
        assert_eq!(go[0].kind, ProblemKind::Compile);
        assert_eq!(go[0].line, Some(31));
    }

    #[test]
    fn classifies_dependency_and_configuration_errors() {
        let dependency = parse_record(&record(
            VerificationKind::Build,
            "npm ERR! 404 Not Found - GET https://registry.npmjs.org/no-such-pkg",
            "",
        ));
        assert_eq!(dependency[0].kind, ProblemKind::Dependency);

        let configuration = parse_record(&record(
            VerificationKind::Build,
            "error: failed to parse tsconfig.json: Unexpected token }",
            "",
        ));
        assert_eq!(configuration[0].kind, ProblemKind::Configuration);
    }

    #[test]
    fn passing_record_yields_no_problems() {
        let passing = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            Some(0),
            "error TS0000: this text must be ignored".into(),
            String::new(),
            10,
            false,
            false,
        );
        assert!(parse_record(&passing).is_empty());
    }

    #[test]
    fn fingerprint_is_stable_across_runs_but_differs_per_problem() {
        let first = parse_record(&record(
            VerificationKind::TypeCheck,
            "src/a.ts(1,1): error TS1: bad",
            "",
        ));
        let again = parse_record(&record(
            VerificationKind::TypeCheck,
            "src/a.ts(1,1): error TS1: bad",
            "",
        ));
        let other = parse_record(&record(
            VerificationKind::TypeCheck,
            "src/b.ts(1,1): error TS1: bad",
            "",
        ));
        assert_eq!(first[0].fingerprint, again[0].fingerprint);
        assert_ne!(first[0].fingerprint, other[0].fingerprint);
    }

    #[test]
    fn fingerprint_ignores_volatile_numbers_and_temp_paths() {
        let first = parse_record(&record(
            VerificationKind::Test,
            "FAILED tests/t.py::test_x - took 1234ms at /tmp/pytest-of-a/run-1/x",
            "",
        ));
        let second = parse_record(&record(
            VerificationKind::Test,
            "FAILED tests/t.py::test_x - took 9876ms at /tmp/pytest-of-a/run-9/x",
            "",
        ));
        assert_eq!(first[0].fingerprint, second[0].fingerprint);
    }

    #[test]
    fn snapshot_roundtrip() {
        let root = std::env::temp_dir().join(format!("coding-diag-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let problems = parse_record(&record(
            VerificationKind::TypeCheck,
            "src/a.ts(3,4): error TS9: nope",
            "",
        ));
        save_snapshot(&root, "task-1", &problems).unwrap();
        let loaded = load_snapshot(&root, "task-1");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].fingerprint, problems[0].fingerprint);
        std::fs::remove_dir_all(&root).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::diagnostics`
Expected: 编译失败，`ProblemKind` / `parse_record` 等未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/diagnostics.rs`：

```rust
//! Diagnostics centre: turn raw compiler / linter / test output into
//! structured problems that carry a file, a line and a stable fingerprint.
//!
//! The fingerprint is what lets the repair engine tell "the same failure came
//! back" apart from "my fix introduced something new", so it deliberately
//! ignores volatile parts of a message such as timings and temp directories.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::coding::store;
use crate::coding::verification::{VerificationKind, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

const MAX_PROBLEMS_PER_RECORD: usize = 200;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    Compile,
    Syntax,
    Type,
    Lint,
    TestFailure,
    Runtime,
    Dependency,
    Configuration,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ProblemSeverity {
    Error,
    Warning,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub id: String,
    pub kind: ProblemKind,
    pub severity: ProblemSeverity,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// Failing test name, or the symbol a compiler error points at.
    pub symbol: Option<String>,
    pub source_command: String,
    /// Stable identity across repair rounds; see module docs.
    pub fingerprint: String,
}

fn diagnostics_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("diagnostics.jsonl")
}

/// Strip volatile substrings so the same underlying failure keeps one identity.
fn normalize_for_fingerprint(message: &str) -> String {
    let without_temp = regex::Regex::new(r"(?:/tmp|/var/folders|[A-Za-z]:\\Temp)[^\s:]*")
        .map(|expression| expression.replace_all(message, "<tmp>").into_owned())
        .unwrap_or_else(|_| message.to_string());
    let without_durations = regex::Regex::new(r"\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b")
        .map(|expression| expression.replace_all(&without_temp, "<duration>").into_owned())
        .unwrap_or(without_temp);
    let without_hex = regex::Regex::new(r"\b0x[0-9a-fA-F]+\b")
        .map(|expression| expression.replace_all(&without_durations, "<addr>").into_owned())
        .unwrap_or(without_durations);
    without_hex.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fingerprint_of(kind: ProblemKind, file: Option<&str>, line: Option<u32>, message: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{kind:?}").as_bytes());
    hasher.update(file.unwrap_or("").as_bytes());
    hasher.update(line.unwrap_or(0).to_le_bytes());
    hasher.update(normalize_for_fingerprint(message).as_bytes());
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Classify a message when the surrounding parser did not already know its
/// kind. Dependency and configuration checks come first because their messages
/// often also contain the word "error".
pub fn classify(message: &str) -> ProblemKind {
    let lowered = message.to_lowercase();
    let dependency = [
        "npm err!",
        "could not resolve dependency",
        "no matching distribution",
        "could not find artifact",
        "unresolved dependency",
        "pip install",
        "cargo: no matching package",
    ];
    if dependency.iter().any(|needle| lowered.contains(needle)) {
        return ProblemKind::Dependency;
    }
    let configuration = [
        "tsconfig",
        "eslintrc",
        ".env",
        "application.yml",
        "application.properties",
        "failed to parse",
        "invalid configuration",
    ];
    if configuration.iter().any(|needle| lowered.contains(needle)) {
        return ProblemKind::Configuration;
    }
    if lowered.contains("syntaxerror") || lowered.contains("parse error") {
        return ProblemKind::Syntax;
    }
    if lowered.contains("type") && (lowered.contains("error") || lowered.contains("mismatch")) {
        return ProblemKind::Type;
    }
    if lowered.contains("assertionerror")
        || lowered.contains("test failed")
        || lowered.starts_with("failed ")
    {
        return ProblemKind::TestFailure;
    }
    if lowered.contains("exception") || lowered.contains("stack trace") {
        return ProblemKind::Runtime;
    }
    ProblemKind::Compile
}

fn severity_of(message: &str) -> ProblemSeverity {
    if message.to_lowercase().contains("warning") {
        ProblemSeverity::Warning
    } else {
        ProblemSeverity::Error
    }
}

fn relative_path(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    trimmed
        .rsplit_once("/repo/")
        .map(|(_, tail)| tail.to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn build(
    kind: ProblemKind,
    message: String,
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    symbol: Option<String>,
    command: &str,
) -> Problem {
    let fingerprint = fingerprint_of(kind, file.as_deref(), line, &message);
    Problem {
        id: uuid::Uuid::now_v7().to_string(),
        kind,
        severity: severity_of(&message),
        message,
        file,
        line,
        column,
        symbol,
        source_command: command.to_string(),
        fingerprint,
    }
}

/// Parse one verification record into problems. A passing record yields none,
/// so text that merely looks like an error can never manufacture a problem.
pub fn parse_record(record: &VerificationRecord) -> Vec<Problem> {
    if record.status == VerificationStatus::Passed {
        return Vec::new();
    }
    let combined = format!("{}\n{}", record.stdout, record.stderr);
    let lines: Vec<&str> = combined.lines().collect();
    let mut problems: Vec<Problem> = Vec::new();
    let mut eslint_file: Option<String> = None;

    let tsc = regex::Regex::new(r"^(?P<file>[^\s(]+)\((?P<line>\d+),(?P<col>\d+)\):\s*(?P<body>.+)$")
        .expect("valid tsc pattern");
    let unix_style =
        regex::Regex::new(r"^(?P<file>[^\s:]+\.[A-Za-z]+):(?P<line>\d+)(?::(?P<col>\d+))?:\s*(?P<body>.+)$")
            .expect("valid unix pattern");
    let eslint_head = regex::Regex::new(r"^(?P<file>(?:/|\./|[A-Za-z]:\\)[^\s]+\.[A-Za-z]+)\s*$")
        .expect("valid eslint head pattern");
    let eslint_row = regex::Regex::new(
        r"^\s+(?P<line>\d+):(?P<col>\d+)\s+(?P<severity>error|warning)\s+(?P<body>.+)$",
    )
    .expect("valid eslint row pattern");
    let rust_head = regex::Regex::new(r"^(?:error|warning)(?:\[[^\]]+\])?:\s*(?P<body>.+)$")
        .expect("valid rustc head pattern");
    let rust_location =
        regex::Regex::new(r"^\s*-->\s*(?P<file>[^\s:]+):(?P<line>\d+):(?P<col>\d+)")
            .expect("valid rustc location pattern");
    let pytest_failure = regex::Regex::new(
        r"^FAILED\s+(?P<file>[^\s:]+)::(?P<symbol>[^\s]+)(?:\s+-\s+(?P<body>.+))?$",
    )
    .expect("valid pytest pattern");

    let mut index = 0;
    while index < lines.len() && problems.len() < MAX_PROBLEMS_PER_RECORD {
        let line = lines[index];
        index += 1;
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            continue;
        }

        if let Some(captures) = eslint_head.captures(trimmed) {
            eslint_file = Some(relative_path(&captures["file"]));
            continue;
        }
        if let Some(captures) = eslint_row.captures(trimmed) {
            let body = captures["body"].trim().to_string();
            let message = format!("{} {}", &captures["severity"], body);
            problems.push(build(
                ProblemKind::Lint,
                message,
                eslint_file.clone(),
                captures["line"].parse().ok(),
                captures["col"].parse().ok(),
                None,
                &record.command,
            ));
            continue;
        }
        if let Some(captures) = pytest_failure.captures(trimmed) {
            let body = captures
                .name("body")
                .map(|value| value.as_str().to_string())
                .unwrap_or_else(|| trimmed.to_string());
            problems.push(build(
                ProblemKind::TestFailure,
                body,
                Some(relative_path(&captures["file"])),
                None,
                None,
                Some(captures["symbol"].to_string()),
                &record.command,
            ));
            continue;
        }
        if let Some(captures) = tsc.captures(trimmed) {
            let body = captures["body"].to_string();
            let kind = if record.kind == VerificationKind::Lint {
                ProblemKind::Lint
            } else {
                classify(&body)
            };
            problems.push(build(
                kind,
                body,
                Some(relative_path(&captures["file"])),
                captures["line"].parse().ok(),
                captures["col"].parse().ok(),
                None,
                &record.command,
            ));
            continue;
        }
        if let Some(captures) = rust_head.captures(trimmed) {
            let body = captures["body"].to_string();
            // rustc prints the location on the next line; consume it when present.
            let (file, line_number, column) = lines
                .get(index)
                .and_then(|next| rust_location.captures(next))
                .map(|location| {
                    (
                        Some(relative_path(&location["file"])),
                        location["line"].parse().ok(),
                        location["col"].parse().ok(),
                    )
                })
                .unwrap_or((None, None, None));
            if file.is_some() {
                index += 1;
            }
            let kind = if trimmed.starts_with("warning") && record.kind == VerificationKind::Lint {
                ProblemKind::Lint
            } else {
                classify(&body)
            };
            problems.push(build(
                kind,
                body,
                file,
                line_number,
                column,
                None,
                &record.command,
            ));
            continue;
        }
        if let Some(captures) = unix_style.captures(trimmed) {
            let body = captures["body"].to_string();
            let kind = match record.kind {
                VerificationKind::TypeCheck => ProblemKind::Type,
                VerificationKind::Lint => ProblemKind::Lint,
                _ => classify(&body),
            };
            problems.push(build(
                kind,
                body,
                Some(relative_path(&captures["file"])),
                captures["line"].parse().ok(),
                captures.name("col").and_then(|value| value.as_str().parse().ok()),
                None,
                &record.command,
            ));
            continue;
        }
    }

    // A failing run with no recognisable location still deserves one problem so
    // the repair engine has something to work from.
    if problems.is_empty() {
        let tail: String = combined
            .lines()
            .filter(|line| !line.trim().is_empty())
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let message = if tail.is_empty() {
            format!("{} 执行失败，未产生可解析输出", record.command)
        } else {
            tail
        };
        let kind = classify(&message);
        problems.push(build(kind, message, None, None, None, None, &record.command));
    }
    problems
}

pub fn save_snapshot(root: &Path, task_id: &str, problems: &[Problem]) -> Result<(), String> {
    let path = diagnostics_path(root, task_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let body = problems
        .iter()
        .map(|problem| serde_json::to_string(problem).unwrap_or_default())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, if body.is_empty() { String::new() } else { format!("{body}\n") })
        .map_err(|error| format!("写入诊断快照失败：{error}"))
}

pub fn load_snapshot(root: &Path, task_id: &str) -> Vec<Problem> {
    store::read_jsonl(&diagnostics_path(root, task_id))
}

#[tauri::command]
pub async fn coding_diagnostics_list(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<Problem>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || load_snapshot(&root, &task_id))
        .await
        .map_err(|error| format!("读取诊断结果失败：{error}"))
}
```

`src-tauri/src/coding/mod.rs` 加 `pub mod diagnostics;`。`lib.rs` 注册 `coding::diagnostics::coding_diagnostics_list,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::diagnostics`
Expected: 10 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增统一诊断中心

验证失败后，工作台此前只能把原始输出整段丢给模型，既无法把问题定位到具体文件和行，也无法判断同一个错误是否在多轮修复中反复出现。本次把编译、语法、类型、静态检查、测试、运行时、依赖与配置错误统一解析为结构化问题，为修复引擎提供可比对的输入。

- 新增 coding/diagnostics.rs，解析 tsc、eslint、rustc、javac、mypy、pytest、go 等常见输出格式并定位文件、行、列与符号
- 为每个问题生成稳定指纹，剥离时长、临时目录与内存地址等易变内容，使同一问题跨轮次可识别
- 通过的验证记录不产生任何问题，避免输出中的 error 字样被误判
- 无法定位位置的失败保留输出尾部作为单条问题，保证修复引擎始终有输入
- 验证：cargo test coding::diagnostics 十个用例通过，覆盖七类输出格式解析、依赖与配置分类、通过记录不产问题、指纹稳定性与易变内容剥离、快照往返
EOF
```

---

### Task 6: Rust 编排状态机

**Files:**
- Create: `src-tauri/src/coding/orchestrator.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod orchestrator;`）
- Modify: `src-tauri/src/lib.rs`（注册 4 个命令）

**Interfaces:**
- Consumes: `coding::task::{CodingTask, TaskPhase, load, save}`、`coding::changeset::load as changeset_load`、`coding::verification::{VerificationRecord, VerificationStatus, VerificationKind, list_records}`、`coding::diagnostics::{Problem, parse_record, save_snapshot}`
- Produces:
  - `RepairRound { round, problem_fingerprints, started_at, outcome }`
  - `RepairOutcome` 枚举：`Fixed | SameErrors | NewErrors | RoundsExhausted`
  - `PhaseDecision { next_phase, reason, blocker }`
  - `coding::orchestrator::decide_after_verification(...) -> PhaseDecision`
  - `coding::orchestrator::next_after_repair(...) -> PhaseDecision`
  - `coding::orchestrator::advance(app,root,task_id,event) -> Result<CodingTask,String>`
  - 命令：`coding_task_submit_requirement`、`coding_task_approve_plan`、`coding_orchestrator_report_verification`、`coding_orchestrator_state`

关键语义（对应设计文档 5.4）：

- 阶段推进只由本模块判定，模型自述不参与。
- `Verifying` → 全绿且有 ChangeSet 才进 `Gating`；有失败进 `Diagnosing`。
- `Diagnosing` → `Repairing`，但先比对指纹：与上一轮完全相同 → `SameErrors`；出现上一轮没有的指纹 → `NewErrors`。两者都直接转 `Blocked`，不再消耗轮次。
- 轮次达到上限（默认 3）→ `RoundsExhausted` → `Blocked`。
- 简单任务（`plan_required == false`）跳过 `Planning` 直接进 `Implementing`。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/orchestrator.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::coding::verification::{record_from_parts, VerificationKind};

    fn passed(command: &str) -> VerificationRecord {
        record_from_parts(
            "task-1",
            VerificationKind::Test,
            command,
            Some(0),
            String::new(),
            String::new(),
            10,
            false,
            false,
        )
    }

    fn failed(command: &str, output: &str) -> VerificationRecord {
        record_from_parts(
            "task-1",
            VerificationKind::Test,
            command,
            Some(1),
            output.to_string(),
            String::new(),
            10,
            false,
            false,
        )
    }

    #[test]
    fn all_green_with_changes_goes_to_gating() {
        let decision = decide_after_verification(&[passed("pnpm build"), passed("pnpm test")], 3, &[], 0);
        assert_eq!(decision.next_phase, TaskPhase::Gating);
        assert!(decision.blocker.is_none());
    }

    #[test]
    fn green_verification_without_any_changes_is_blocked() {
        let decision = decide_after_verification(&[passed("pnpm test")], 0, &[], 0);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision
            .blocker
            .as_deref()
            .unwrap()
            .contains("没有产生任何代码变更"));
    }

    #[test]
    fn failure_goes_to_diagnosing() {
        let decision = decide_after_verification(
            &[failed("pnpm test", "src/a.ts(1,1): error TS1: bad")],
            2,
            &[],
            0,
        );
        assert_eq!(decision.next_phase, TaskPhase::Diagnosing);
    }

    #[test]
    fn identical_fingerprints_across_rounds_block_instead_of_looping() {
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let problems = crate::coding::diagnostics::parse_record(&record);
        let previous: Vec<String> = problems
            .iter()
            .map(|problem| problem.fingerprint.clone())
            .collect();
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("相同错误"));
    }

    #[test]
    fn new_fingerprints_after_repair_block_as_regression() {
        let previous = vec!["aaaaaaaa".to_string()];
        let record = failed("pnpm test", "src/b.ts(9,9): error TS7: different");
        let problems = crate::coding::diagnostics::parse_record(&record);
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("新的错误"));
    }

    #[test]
    fn shrinking_problem_set_continues_repairing() {
        let previous = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()];
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let mut problems = crate::coding::diagnostics::parse_record(&record);
        problems[0].fingerprint = "aaaaaaaa".into();
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Repairing);
    }

    #[test]
    fn exhausted_rounds_block_even_when_progress_is_being_made() {
        let previous = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()];
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let mut problems = crate::coding::diagnostics::parse_record(&record);
        problems[0].fingerprint = "aaaaaaaa".into();
        let decision = next_after_repair(&problems, &previous, 3, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("修复轮次"));
    }

    #[test]
    fn empty_problem_set_after_repair_returns_to_verifying() {
        let decision = next_after_repair(&[], &["aaaaaaaa".to_string()], 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Verifying);
    }

    #[test]
    fn requirement_submission_respects_plan_flag() {
        assert_eq!(phase_after_requirement(true), TaskPhase::Planning);
        assert_eq!(phase_after_requirement(false), TaskPhase::Implementing);
    }

    #[test]
    fn cancelled_or_timed_out_verification_is_not_a_pass() {
        let cancelled = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            10,
            false,
            true,
        );
        let decision = decide_after_verification(&[cancelled], 2, &[], 0);
        assert_eq!(decision.next_phase, TaskPhase::Diagnosing);
    }

    #[test]
    fn only_latest_run_per_command_counts() {
        // An early failure that a later run fixed must not keep the task red.
        let decision = decide_after_verification(
            &[
                failed("pnpm test", "src/a.ts(1,1): error TS1: bad"),
                passed("pnpm test"),
            ],
            2,
            &[],
            0,
        );
        assert_eq!(decision.next_phase, TaskPhase::Gating);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::orchestrator`
Expected: 编译失败，`decide_after_verification` / `next_after_repair` / `phase_after_requirement` 未定义。

- [ ] **Step 3: 写实现**

`src-tauri/src/coding/orchestrator.rs`：

```rust
//! Phase orchestration for a coding task.
//!
//! The workbench — not the model — decides when a task moves forward. A phase
//! transition is derived from real evidence: process exit codes, the change set
//! on disk and diagnostic fingerprints. This is what stops a model that claims
//! "all tests pass" from marking work complete, and what stops a repair loop
//! from burning tokens on the same failure forever.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::coding::changeset;
use crate::coding::diagnostics::{self, Problem};
use crate::coding::store;
use crate::coding::task::{self, CodingTask, TaskPhase};
use crate::coding::verification::{self, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

pub const DEFAULT_MAX_REPAIR_ROUNDS: u32 = 3;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RepairOutcome {
    Fixed,
    SameErrors,
    NewErrors,
    RoundsExhausted,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepairRound {
    pub round: u32,
    pub problem_fingerprints: Vec<String>,
    pub started_at: String,
    pub outcome: Option<RepairOutcome>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDecision {
    pub next_phase: TaskPhase,
    pub reason: String,
    /// Human-readable blocker, set only when `next_phase` is `Blocked`.
    pub blocker: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorState {
    pub task: CodingTask,
    pub problems: Vec<Problem>,
    pub repair_rounds: Vec<RepairRound>,
    pub changed_file_count: usize,
    pub max_repair_rounds: u32,
}

fn repairs_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("repairs.jsonl")
}

pub fn repair_rounds(root: &Path, task_id: &str) -> Vec<RepairRound> {
    store::read_jsonl(&repairs_path(root, task_id))
}

fn append_round(root: &Path, task_id: &str, round: &RepairRound) -> Result<(), String> {
    store::append_jsonl(&repairs_path(root, task_id), round)
}

/// A simple task skips planning; only work the user marked as plan-first stops
/// for approval.
pub fn phase_after_requirement(plan_required: bool) -> TaskPhase {
    if plan_required {
        TaskPhase::Planning
    } else {
        TaskPhase::Implementing
    }
}

/// Keep only the most recent run of each command, so a failure that a later run
/// fixed does not hold the task in a red state.
fn latest_per_command(records: &[VerificationRecord]) -> Vec<&VerificationRecord> {
    let mut latest: Vec<&VerificationRecord> = Vec::new();
    for record in records {
        match latest
            .iter_mut()
            .find(|existing| existing.command == record.command)
        {
            Some(existing) => *existing = record,
            None => latest.push(record),
        }
    }
    latest
}

/// Decide where a task goes once verification finished.
pub fn decide_after_verification(
    records: &[VerificationRecord],
    changed_file_count: usize,
    _previous_fingerprints: &[String],
    _completed_rounds: u32,
) -> PhaseDecision {
    let effective = latest_per_command(records);
    let failing: Vec<&&VerificationRecord> = effective
        .iter()
        .filter(|record| record.status != VerificationStatus::Passed)
        .collect();

    if !failing.is_empty() {
        let commands = failing
            .iter()
            .map(|record| record.command.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return PhaseDecision {
            next_phase: TaskPhase::Diagnosing,
            reason: format!("以下验证未通过：{commands}"),
            blocker: None,
        };
    }

    if changed_file_count == 0 {
        return PhaseDecision {
            next_phase: TaskPhase::Blocked,
            reason: "验证通过但没有代码变更".into(),
            blocker: Some(
                "本轮没有产生任何代码变更，无法作为已完成的开发任务交付。请确认需求是否已被实现。"
                    .into(),
            ),
        };
    }

    PhaseDecision {
        next_phase: TaskPhase::Gating,
        reason: "全部验证通过且存在代码变更".into(),
        blocker: None,
    }
}

/// Decide whether another repair round is worth attempting.
pub fn next_after_repair(
    problems: &[Problem],
    previous_fingerprints: &[String],
    completed_rounds: u32,
    max_rounds: u32,
) -> PhaseDecision {
    if problems.is_empty() {
        return PhaseDecision {
            next_phase: TaskPhase::Verifying,
            reason: "修复后没有残留问题，重新执行验证".into(),
            blocker: None,
        };
    }

    let current: HashSet<&str> = problems
        .iter()
        .map(|problem| problem.fingerprint.as_str())
        .collect();
    let previous: HashSet<&str> = previous_fingerprints
        .iter()
        .map(|value| value.as_str())
        .collect();

    if !previous.is_empty() {
        let introduced: Vec<&&str> = current.difference(&previous).collect();
        if !introduced.is_empty() {
            return PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "修复引入了新的错误".into(),
                blocker: Some(format!(
                    "上一轮修复引入了 {} 个新的错误，已停止自动修复以避免问题扩散。请人工确认修改方向。",
                    introduced.len()
                )),
            };
        }
        if current == previous {
            return PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "修复后仍是相同错误".into(),
                blocker: Some(
                    "修复后出现完全相同错误，说明当前思路无效，已停止自动修复以避免空转。请人工介入。"
                        .into(),
                ),
            };
        }
    }

    if completed_rounds >= max_rounds {
        return PhaseDecision {
            next_phase: TaskPhase::Blocked,
            reason: "修复轮次已用尽".into(),
            blocker: Some(format!(
                "已执行 {completed_rounds} 轮自动修复仍有 {} 个问题未解决，修复轮次上限为 {max_rounds}。请人工介入。",
                problems.len()
            )),
        };
    }

    PhaseDecision {
        next_phase: TaskPhase::Repairing,
        reason: format!("问题数量下降到 {}，继续自动修复", problems.len()),
        blocker: None,
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum OrchestratorEvent {
    /// The user submitted a requirement; the task leaves Idle.
    RequirementSubmitted { plan_required: bool },
    /// The user approved the plan the Agent produced.
    PlanApproved,
    /// The Agent finished writing code for this round.
    ImplementationFinished,
    /// A verification batch finished; recompute from records on disk.
    VerificationFinished,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PhaseChangedPayload {
    task_id: String,
    phase: TaskPhase,
    reason: String,
    blocker: Option<String>,
}

/// Apply one event and persist the resulting phase.
pub fn apply(
    root: &Path,
    task_id: &str,
    event: OrchestratorEvent,
) -> Result<(CodingTask, PhaseDecision), String> {
    let mut task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    let changed_file_count = changeset::load(root, task_id)
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
        .count();

    let decision = match event {
        OrchestratorEvent::RequirementSubmitted { plan_required } => {
            task.plan_required = plan_required;
            let next = phase_after_requirement(plan_required);
            PhaseDecision {
                next_phase: next,
                reason: if plan_required {
                    "需求已提交，等待 Agent 给出计划".into()
                } else {
                    "需求已提交，直接开始实现".into()
                },
                blocker: None,
            }
        }
        OrchestratorEvent::PlanApproved => PhaseDecision {
            next_phase: TaskPhase::Implementing,
            reason: "计划已批准".into(),
            blocker: None,
        },
        OrchestratorEvent::ImplementationFinished => {
            if changed_file_count == 0 {
                PhaseDecision {
                    next_phase: TaskPhase::Blocked,
                    reason: "实现阶段结束但没有代码变更".into(),
                    blocker: Some(
                        "Agent 结束了实现但没有写入任何文件。请检查是否只在会话里返回了示例代码。"
                            .into(),
                    ),
                }
            } else {
                PhaseDecision {
                    next_phase: TaskPhase::Verifying,
                    reason: format!("已产生 {changed_file_count} 个文件变更，开始验证"),
                    blocker: None,
                }
            }
        }
        OrchestratorEvent::VerificationFinished => {
            let records = verification::list_records(root, task_id);
            let problems: Vec<Problem> = latest_per_command(&records)
                .iter()
                .flat_map(|record| diagnostics::parse_record(record))
                .collect();
            diagnostics::save_snapshot(root, task_id, &problems)?;

            let rounds = repair_rounds(root, task_id);
            let completed = rounds.len() as u32;
            let previous: Vec<String> = rounds
                .last()
                .map(|round| round.problem_fingerprints.clone())
                .unwrap_or_default();

            let verdict =
                decide_after_verification(&records, changed_file_count, &previous, completed);
            if verdict.next_phase != TaskPhase::Diagnosing {
                verdict
            } else {
                // Failing verification: decide whether to repair again, and open
                // a round so the next comparison has a baseline.
                let decision =
                    next_after_repair(&problems, &previous, completed, DEFAULT_MAX_REPAIR_ROUNDS);
                if decision.next_phase == TaskPhase::Repairing {
                    append_round(
                        root,
                        task_id,
                        &RepairRound {
                            round: completed + 1,
                            problem_fingerprints: problems
                                .iter()
                                .map(|problem| problem.fingerprint.clone())
                                .collect(),
                            started_at: chrono::Utc::now().to_rfc3339(),
                            outcome: None,
                        },
                    )?;
                }
                decision
            }
        }
    };

    task.phase = decision.next_phase;
    task::save(root, &task)?;
    Ok((task, decision))
}

async fn apply_and_emit(
    app: AppHandle,
    root: PathBuf,
    task_id: String,
    event: OrchestratorEvent,
) -> Result<CodingTask, String> {
    let (task, decision) = tokio::task::spawn_blocking({
        let root = root.clone();
        let task_id = task_id.clone();
        move || apply(&root, &task_id, event)
    })
    .await
    .map_err(|error| format!("推进任务阶段失败：{error}"))??;
    let _ = app.emit(
        "coding://task-phase-changed",
        PhaseChangedPayload {
            task_id,
            phase: task.phase,
            reason: decision.reason,
            blocker: decision.blocker,
        },
    );
    Ok(task)
}

#[tauri::command]
pub async fn coding_task_submit_requirement(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    plan_required: bool,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(
        app,
        root,
        task_id,
        OrchestratorEvent::RequirementSubmitted { plan_required },
    )
    .await
}

#[tauri::command]
pub async fn coding_task_approve_plan(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::PlanApproved).await
}

#[tauri::command]
pub async fn coding_orchestrator_report_verification(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::VerificationFinished).await
}

#[tauri::command]
pub async fn coding_orchestrator_state(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<OrchestratorState, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || {
        let task = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        Ok(OrchestratorState {
            problems: diagnostics::load_snapshot(&root, &task_id),
            repair_rounds: repair_rounds(&root, &task_id),
            changed_file_count: changeset::load(&root, &task_id)
                .changes
                .iter()
                .filter(|change| !change.pre_existing)
                .count(),
            max_repair_rounds: DEFAULT_MAX_REPAIR_ROUNDS,
            task,
        })
    })
    .await
    .map_err(|error| format!("读取编排状态失败：{error}"))?
}
```

`src-tauri/src/coding/mod.rs` 加 `pub mod orchestrator;`。`lib.rs` 注册：

```rust
            coding::orchestrator::coding_task_submit_requirement,
            coding::orchestrator::coding_task_approve_plan,
            coding::orchestrator::coding_orchestrator_report_verification,
            coding::orchestrator::coding_orchestrator_state,
```

同时给 `coding/verification.rs` 补一个 `ImplementationFinished` 的触发点说明：Agent 完成一轮后由前端调用 `coding_orchestrator_report_verification`，不需要额外命令。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::orchestrator`
Expected: 11 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增任务阶段编排状态机

代码开发的闭环此前完全依赖 prompt 约束模型自觉执行，前端再从消息流里猜测当前状态，导致模型声称测试通过就能结束任务、修复失败时可能反复重试同一个思路。本次把阶段推进权收到后端，全部依据真实证据判定。

- 新增 coding/orchestrator.rs，按需求提交、计划批准、实现结束、验证结束四类事件推进阶段
- 验证结论按命令取最近一次执行结果，早期失败被后续成功覆盖后不再阻塞任务
- 验证全绿但没有代码变更时判为阻塞，避免空转被当作交付
- 修复前比对诊断指纹：出现新错误判为修复引入回归，指纹完全相同判为思路无效，两者都停止自动修复
- 修复轮次达到上限即阻塞并输出具体原因，阻塞信息随阶段变更事件推送到前端
- 验证：cargo test coding::orchestrator 十一个用例通过，覆盖全绿进入门禁、无变更阻塞、失败进入诊断、相同指纹与新指纹阻塞、问题减少继续修复、轮次耗尽阻塞、取消与超时不算通过、同命令取最新结果
EOF
```

---

### Task 7: Rust 交付层

**Files:**
- Create: `src-tauri/src/coding/delivery.rs`
- Modify: `src-tauri/src/coding/mod.rs`（加 `pub mod delivery;`）
- Modify: `src-tauri/src/lib.rs`（注册 4 个命令）

**Interfaces:**
- Consumes: `coding::task::{CodingTask, TaskPhase, AcceptanceCriterion, load, save}`、`coding::changeset::load as changeset_load`、`coding::verification::{VerificationRecord, VerificationKind, VerificationStatus, list_records}`、`coding::diagnostics::load_snapshot`、`coding::orchestrator::{repair_rounds, RepairRound}`
- Produces:
  - `GateId` 枚举：`Build | Test | Lint | TypeCheck | DiffReview | Acceptance`
  - `GateStatus` 枚举：`Satisfied | NotSatisfied | NotApplicable`
  - `QualityGate { id, title, status, summary, evidence }`
  - `EvidenceEntry { criterion_id, kind, detail, source }`
  - `DeliveryReport { task, gates, changes, verifications, problems, repair_rounds, evidence, blockers, deliverable }`
  - `coding::delivery::evaluate_gates(...) -> Vec<QualityGate>`
  - `coding::delivery::build_report(root,&str) -> Result<DeliveryReport,String>`
  - `coding::delivery::commit_message_input(...) -> String`（供模型生成提交信息的结构化输入）
  - 命令：`coding_delivery_report`、`coding_delivery_commit_input`、`coding_git_commit`、`coding_delivery_pr_input`

关键语义：

- 门禁只按真实证据判定。项目没有 lint 命令时该门禁为 `NotApplicable`，不是通过也不是失败。
- `deliverable` 为 true 的唯一条件：所有 `Satisfied` 或 `NotApplicable`，且无 `NotSatisfied`。
- `Acceptance` 门禁要求每条验收标准都有 evidence，空 evidence 一律 `NotSatisfied`（对应清单 16.11）。
- `coding_git_commit` 只提交 ChangeSet 内非 `pre_existing` 的文件路径，绝不 `git add -A`。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/coding/delivery.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::coding::changeset::{ChangeKind, ChangeSet, FileChange};
    use crate::coding::verification::{record_from_parts, VerificationKind};

    fn record(kind: VerificationKind, command: &str, exit: i32) -> VerificationRecord {
        record_from_parts(
            "task-1",
            kind,
            command,
            Some(exit),
            String::new(),
            String::new(),
            10,
            false,
            false,
        )
    }

    fn change_set(reviewed: bool) -> ChangeSet {
        ChangeSet {
            task_id: "task-1".into(),
            baseline_files: Vec::new(),
            changes: vec![FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 10,
                removed: 2,
                baseline_content: Some("old".into()),
                pre_existing: false,
            }],
            created_at: "2026-09-11T00:00:00Z".into(),
            reviewed_files: if reviewed {
                vec!["src/a.ts".to_string()]
            } else {
                Vec::new()
            },
        }
    }

    fn criteria(satisfied: bool) -> Vec<AcceptanceCriterion> {
        vec![AcceptanceCriterion {
            id: "ac1".into(),
            content: "登录流程可用".into(),
            satisfied,
            evidence: if satisfied {
                vec!["pnpm test 通过".to_string()]
            } else {
                Vec::new()
            },
        }]
    }

    #[test]
    fn missing_command_kind_is_not_applicable_not_failure() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(true),
            &criteria(true),
            &[],
        );
        let lint = gates.iter().find(|gate| gate.id == GateId::Lint).unwrap();
        assert_eq!(lint.status, GateStatus::NotApplicable);
        assert!(is_deliverable(&gates));
    }

    #[test]
    fn failing_test_makes_gate_not_satisfied_and_blocks_delivery() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 1)],
            &change_set(true),
            &criteria(true),
            &[],
        );
        let test = gates.iter().find(|gate| gate.id == GateId::Test).unwrap();
        assert_eq!(test.status, GateStatus::NotSatisfied);
        assert!(!is_deliverable(&gates));
    }

    #[test]
    fn acceptance_without_evidence_is_not_satisfied() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(true),
            &criteria(false),
            &[],
        );
        let acceptance = gates
            .iter()
            .find(|gate| gate.id == GateId::Acceptance)
            .unwrap();
        assert_eq!(acceptance.status, GateStatus::NotSatisfied);
        assert!(!is_deliverable(&gates));
    }

    #[test]
    fn unreviewed_changes_fail_diff_review_gate() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(false),
            &criteria(true),
            &[],
        );
        let review = gates
            .iter()
            .find(|gate| gate.id == GateId::DiffReview)
            .unwrap();
        assert_eq!(review.status, GateStatus::NotSatisfied);
        assert!(review.summary.contains("1"));
    }

    #[test]
    fn empty_change_set_fails_diff_review() {
        let empty = ChangeSet {
            task_id: "task-1".into(),
            baseline_files: Vec::new(),
            changes: Vec::new(),
            created_at: "2026-09-11T00:00:00Z".into(),
            reviewed_files: Vec::new(),
        };
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &empty,
            &criteria(true),
            &[],
        );
        let review = gates
            .iter()
            .find(|gate| gate.id == GateId::DiffReview)
            .unwrap();
        assert_eq!(review.status, GateStatus::NotSatisfied);
    }

    #[test]
    fn latest_run_of_a_command_decides_its_gate() {
        let gates = evaluate_gates(
            &[
                record(VerificationKind::Build, "pnpm build", 1),
                record(VerificationKind::Build, "pnpm build", 0),
            ],
            &change_set(true),
            &criteria(true),
            &[],
        );
        let build = gates.iter().find(|gate| gate.id == GateId::Build).unwrap();
        assert_eq!(build.status, GateStatus::Satisfied);
    }

    #[test]
    fn all_gate_kinds_are_always_reported() {
        let gates = evaluate_gates(&[], &change_set(true), &criteria(true), &[]);
        for id in [
            GateId::Build,
            GateId::Test,
            GateId::Lint,
            GateId::TypeCheck,
            GateId::DiffReview,
            GateId::Acceptance,
        ] {
            assert!(gates.iter().any(|gate| gate.id == id), "缺少门禁 {id:?}");
        }
    }

    #[test]
    fn commit_message_input_lists_only_task_changes() {
        let mut set = change_set(true);
        set.changes.push(FileChange {
            path: "src/user-edit.ts".into(),
            kind: ChangeKind::Modified,
            added: 3,
            removed: 1,
            baseline_content: Some("x".into()),
            pre_existing: true,
        });
        let input = commit_message_input("重构登录", "把登录改成 OIDC", &set, &[]);
        assert!(input.contains("src/a.ts"));
        // A file the user had already edited must not be attributed to this task.
        assert!(!input.contains("src/user-edit.ts"));
    }

    #[test]
    fn commit_paths_exclude_pre_existing_files() {
        let mut set = change_set(true);
        set.changes.push(FileChange {
            path: "src/user-edit.ts".into(),
            kind: ChangeKind::Modified,
            added: 3,
            removed: 1,
            baseline_content: Some("x".into()),
            pre_existing: true,
        });
        let paths = committable_paths(&set);
        assert_eq!(paths, vec!["src/a.ts".to_string()]);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test coding::delivery`
Expected: 编译失败，`GateId` / `evaluate_gates` / `is_deliverable` / `committable_paths` / `commit_message_input` 未定义。（`ChangeSet::reviewed_files` 与 `mark_reviewed` 已在 Task 3 落地，此处直接使用。）

- [ ] **Step 3: 写交付层实现**

`src-tauri/src/coding/delivery.rs`：

```rust
//! Quality gates, delivery report and Git handoff.
//!
//! Every gate verdict is derived from stored evidence: exit codes, the change
//! set, review marks and acceptance evidence. A gate a project cannot run (no
//! lint script, for instance) reports as not-applicable rather than silently
//! passing, so a green report always means something was actually checked.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::changeset::{self, ChangeSet, FileChange};
use crate::coding::diagnostics::{self, Problem};
use crate::coding::orchestrator::{self, RepairRound};
use crate::coding::task::{self, AcceptanceCriterion, CodingTask};
use crate::coding::verification::{
    self, VerificationKind, VerificationRecord, VerificationStatus,
};
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GateId {
    Build,
    Test,
    Lint,
    TypeCheck,
    DiffReview,
    Acceptance,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Satisfied,
    NotSatisfied,
    /// The project has no such check; nothing was verified and nothing failed.
    NotApplicable,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QualityGate {
    pub id: GateId,
    pub title: String,
    pub status: GateStatus,
    pub summary: String,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceEntry {
    pub criterion_id: String,
    pub kind: String,
    pub detail: String,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReport {
    pub task: CodingTask,
    pub gates: Vec<QualityGate>,
    pub changes: Vec<FileChange>,
    pub total_added: u32,
    pub total_removed: u32,
    pub verifications: Vec<VerificationRecord>,
    pub problems: Vec<Problem>,
    pub repair_rounds: Vec<RepairRound>,
    pub evidence: Vec<EvidenceEntry>,
    pub blockers: Vec<String>,
    /// True only when no gate is NotSatisfied.
    pub deliverable: bool,
}

fn title_for(id: GateId) -> &'static str {
    match id {
        GateId::Build => "构建通过",
        GateId::Test => "测试通过",
        GateId::Lint => "静态检查通过",
        GateId::TypeCheck => "类型检查通过",
        GateId::DiffReview => "变更已审阅",
        GateId::Acceptance => "验收标准已核销",
    }
}

fn latest_per_command(records: &[VerificationRecord]) -> Vec<&VerificationRecord> {
    let mut latest: Vec<&VerificationRecord> = Vec::new();
    for record in records {
        match latest
            .iter_mut()
            .find(|existing| existing.command == record.command)
        {
            Some(existing) => *existing = record,
            None => latest.push(record),
        }
    }
    latest
}

fn verification_gate(
    id: GateId,
    kind: VerificationKind,
    records: &[VerificationRecord],
) -> QualityGate {
    let effective = latest_per_command(records);
    let relevant: Vec<&&VerificationRecord> = effective
        .iter()
        .filter(|record| record.kind == kind)
        .collect();

    if relevant.is_empty() {
        return QualityGate {
            id,
            title: title_for(id).into(),
            status: GateStatus::NotApplicable,
            summary: "当前工程未识别到该类检查命令".into(),
            evidence: Vec::new(),
        };
    }
    let failing: Vec<&&&VerificationRecord> = relevant
        .iter()
        .filter(|record| record.status != VerificationStatus::Passed)
        .collect();
    let evidence: Vec<String> = relevant
        .iter()
        .map(|record| {
            let verdict = match record.status {
                VerificationStatus::Passed => "通过",
                VerificationStatus::Failed => "失败",
                VerificationStatus::TimedOut => "超时",
                VerificationStatus::Cancelled => "已取消",
                VerificationStatus::Running => "执行中",
            };
            let detail = record
                .test_summary
                .map(|summary| {
                    format!(
                        "，{} 通过 / {} 失败 / {} 跳过",
                        summary.passed, summary.failed, summary.skipped
                    )
                })
                .unwrap_or_default();
            format!(
                "{}：{verdict}（退出码 {}）{detail}",
                record.command,
                record
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "无".into())
            )
        })
        .collect();

    QualityGate {
        id,
        title: title_for(id).into(),
        status: if failing.is_empty() {
            GateStatus::Satisfied
        } else {
            GateStatus::NotSatisfied
        },
        summary: if failing.is_empty() {
            format!("{} 项检查全部通过", relevant.len())
        } else {
            format!("{} 项检查未通过", failing.len())
        },
        evidence,
    }
}

pub fn evaluate_gates(
    records: &[VerificationRecord],
    set: &ChangeSet,
    criteria: &[AcceptanceCriterion],
    problems: &[Problem],
) -> Vec<QualityGate> {
    let mut gates = vec![
        verification_gate(GateId::Build, VerificationKind::Build, records),
        verification_gate(GateId::Test, VerificationKind::Test, records),
        verification_gate(GateId::Lint, VerificationKind::Lint, records),
        verification_gate(GateId::TypeCheck, VerificationKind::TypeCheck, records),
    ];

    let task_changes: Vec<&FileChange> = set
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
        .collect();
    let unreviewed: Vec<&&FileChange> = task_changes
        .iter()
        .filter(|change| !set.reviewed_files.iter().any(|path| path == &change.path))
        .collect();
    gates.push(QualityGate {
        id: GateId::DiffReview,
        title: title_for(GateId::DiffReview).into(),
        status: if task_changes.is_empty() || !unreviewed.is_empty() {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if task_changes.is_empty() {
            "本任务没有产生代码变更".into()
        } else if unreviewed.is_empty() {
            format!("{} 个变更文件已全部审阅", task_changes.len())
        } else {
            format!("还有 {} 个变更文件未审阅", unreviewed.len())
        },
        evidence: task_changes
            .iter()
            .map(|change| format!("{} (+{} -{})", change.path, change.added, change.removed))
            .collect(),
    });

    let unmet: Vec<&AcceptanceCriterion> = criteria
        .iter()
        .filter(|criterion| !criterion.satisfied || criterion.evidence.is_empty())
        .collect();
    gates.push(QualityGate {
        id: GateId::Acceptance,
        title: title_for(GateId::Acceptance).into(),
        status: if criteria.is_empty() || !unmet.is_empty() {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if criteria.is_empty() {
            "尚未生成验收标准".into()
        } else if unmet.is_empty() {
            format!("{} 条验收标准均有验证证据", criteria.len())
        } else {
            format!("还有 {} 条验收标准缺少验证证据", unmet.len())
        },
        evidence: criteria
            .iter()
            .map(|criterion| {
                format!(
                    "{}：{}",
                    criterion.content,
                    if criterion.evidence.is_empty() {
                        "无证据".to_string()
                    } else {
                        criterion.evidence.join("；")
                    }
                )
            })
            .collect(),
    });

    if !problems.is_empty() {
        if let Some(gate) = gates.iter_mut().find(|gate| gate.id == GateId::Test) {
            gate.evidence
                .push(format!("诊断中心仍有 {} 个未解决问题", problems.len()));
        }
    }
    gates
}

pub fn is_deliverable(gates: &[QualityGate]) -> bool {
    gates
        .iter()
        .all(|gate| gate.status != GateStatus::NotSatisfied)
}

pub fn committable_paths(set: &ChangeSet) -> Vec<String> {
    set.changes
        .iter()
        .filter(|change| !change.pre_existing)
        .map(|change| change.path.clone())
        .collect()
}

/// Structured input a model turns into a commit message. Deliberately excludes
/// files the user had already modified so the message never claims them.
pub fn commit_message_input(
    name: &str,
    requirement: &str,
    set: &ChangeSet,
    records: &[VerificationRecord],
) -> String {
    let files = set
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
        .map(|change| {
            format!(
                "- {} ({:?}, +{} -{})",
                change.path, change.kind, change.added, change.removed
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let verifications = latest_per_command(records)
        .iter()
        .map(|record| format!("- {}：{:?}", record.command, record.status))
        .collect::<Vec<_>>()
        .join("\n");
    [
        format!("任务名称：{name}"),
        format!("原始需求：{requirement}"),
        "变更文件：".to_string(),
        if files.is_empty() {
            "- 无".into()
        } else {
            files
        },
        "验证结果：".to_string(),
        if verifications.is_empty() {
            "- 未执行".into()
        } else {
            verifications
        },
    ]
    .join("\n")
}

pub fn build_report(root: &Path, task_id: &str) -> Result<DeliveryReport, String> {
    let task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    let set = changeset::load(root, task_id);
    let records = verification::list_records(root, task_id);
    let problems = diagnostics::load_snapshot(root, task_id);
    let gates = evaluate_gates(&records, &set, &task.acceptance_criteria, &problems);
    let evidence = task
        .acceptance_criteria
        .iter()
        .flat_map(|criterion| {
            criterion
                .evidence
                .iter()
                .map(|detail| EvidenceEntry {
                    criterion_id: criterion.id.clone(),
                    kind: "acceptance".into(),
                    detail: detail.clone(),
                    source: "verification".into(),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let blockers = gates
        .iter()
        .filter(|gate| gate.status == GateStatus::NotSatisfied)
        .map(|gate| format!("{}：{}", gate.title, gate.summary))
        .collect();
    Ok(DeliveryReport {
        total_added: set.total_added(),
        total_removed: set.total_removed(),
        changes: set.changes.clone(),
        deliverable: is_deliverable(&gates),
        gates,
        verifications: records,
        problems,
        repair_rounds: orchestrator::repair_rounds(root, task_id),
        evidence,
        blockers,
        task,
    })
}

async fn git(root: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .await
        .map_err(|error| format!("执行 git 失败：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn coding_delivery_report(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || build_report(&root, &task_id))
        .await
        .map_err(|error| format!("生成交付报告失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_commit_input(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || {
        let task = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        Ok(commit_message_input(
            &task.name,
            &task.requirement,
            &changeset::load(&root, &task_id),
            &verification::list_records(&root, &task_id),
        ))
    })
    .await
    .map_err(|error| format!("生成提交信息输入失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_pr_input(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    // A PR description needs exactly the report's content; reuse it rather than
    // maintaining a second aggregation path.
    coding_delivery_report(access, root, task_id).await
}

/// Stage only this task's files and commit them. Never `git add -A`, so a
/// user's unrelated uncommitted work is never swept into the task's commit.
#[tauri::command]
pub async fn coding_git_commit(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
    let trimmed = message.trim().to_string();
    if trimmed.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let set = {
        let root = root.clone();
        let task_id = task_id.clone();
        tokio::task::spawn_blocking(move || changeset::load(&root, &task_id))
            .await
            .map_err(|error| format!("读取变更集失败：{error}"))?
    };
    let paths = committable_paths(&set);
    if paths.is_empty() {
        return Err("本任务没有可提交的变更".into());
    }
    for path in &paths {
        if path.starts_with('/') || path.contains("..") {
            return Err(format!("非法的提交路径：{path}"));
        }
    }
    let mut add_arguments: Vec<&str> = vec!["add", "--"];
    add_arguments.extend(paths.iter().map(|path| path.as_str()));
    git(&root, &add_arguments).await?;
    git(&root, &["commit", "-m", &trimmed]).await?;
    git(&root, &["rev-parse", "HEAD"])
        .await
        .map(|hash| hash.trim().to_string())
}
```

`src-tauri/src/coding/mod.rs` 加 `pub mod delivery;`。`lib.rs` 注册：

```rust
            coding::delivery::coding_delivery_report,
            coding::delivery::coding_delivery_commit_input,
            coding::delivery::coding_delivery_pr_input,
            coding::delivery::coding_git_commit,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test coding::`
Expected: Task 1-7 全部测试 PASS（store 3 + task 4 + changeset 6 + verification 8 + diagnostics 10 + orchestrator 11 + delivery 9 = 51 个）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/coding/ src-tauri/src/lib.rs
git commit -F - <<'EOF'
新增质量门禁与交付报告

工作台此前已实现门禁判定与验收报告的计算逻辑，但界面从未引用，交付环节实际是断开的：用户看不到门禁结论，也无法在工作台内完成提交。本次把门禁、报告、证据链与 Git 提交串成完整交付路径。

- 新增 coding/delivery.rs，输出构建、测试、静态检查、类型检查、变更审阅、验收核销六项门禁
- 工程未识别到某类检查命令时判为不适用，与通过和失败区分开，避免空检查被当作达标
- 验收标准缺少验证证据一律判为未满足，变更文件未逐个审阅时审阅门禁不通过
- 为变更集增加已审阅文件记录，作为审阅门禁的判定依据
- 提交只暂存本任务产生的文件路径，排除任务开始前用户已有的改动，不使用全量暂存
- 提交信息与 PR 描述的结构化输入复用同一份报告数据
- 验证：cargo test coding:: 五十个用例通过，其中交付层九个覆盖不适用门禁、失败阻断交付、验收无证据、未审阅变更、空变更集、同命令取最新结果、六项门禁齐全、提交输入与提交路径排除用户改动
EOF
```

---

### Task 8: 后端阻塞 IO 修复与旧命令下线

**Files:**
- Modify: `src-tauri/src/coding_workspace.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: 现有 `coding_analyze_workspace`、`coding_search_workspace` 等命令
- Produces: 同名命令，签名不变，但内部改为不阻塞 tokio worker；新增 `coding_analyze_workspace` 的增量事件 `coding://analysis-progress`

改造要点：

1. `coding_analyze_workspace`（`coding_workspace.rs:1373`）：整个目录遍历移入 `spawn_blocking`，并在每扫描 2000 个文件时通过事件推送部分结果。
2. `coding_search_workspace`（`coding_workspace.rs:1246`）：同样移入 `spawn_blocking`。
3. 其余同步 `std::fs::` 调用（`coding_read_document`、`coding_write_document`、`coding_create_entry`、`coding_git_diff` 内的未跟踪文件读取）改为 `tokio::fs`。
4. 删除 `coding_run_command` 与 `coding_cancel_command`（Task 4 的 `verification::run` / `coding_verification_cancel` 已取代），从 `lib.rs` 移除注册。

- [ ] **Step 1: 写失败测试**

新建 `src-tauri/tests/coding_workspace_async_test.rs`：

```rust
//! Guards the async contract of the coding workspace commands: a long scan must
//! not block the tokio runtime, and the retired command names must be gone.

use std::time::Duration;

/// A blocking scan on a worker thread would starve this concurrent timer. With
/// the scan moved onto the blocking pool the timer keeps its own schedule.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocking_scan_does_not_starve_the_runtime() {
    let scan = tokio::task::spawn_blocking(|| {
        // Simulate the synchronous directory walk the real command performs.
        std::thread::sleep(Duration::from_millis(400));
        12_000usize
    });

    let mut ticks = 0u32;
    let ticker = async {
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            ticks += 1;
        }
    };
    let (scanned, ()) = tokio::join!(async { scan.await.unwrap() }, ticker);

    assert_eq!(scanned, 12_000);
    // All timer ticks fired while the scan was still running.
    assert_eq!(ticks, 8);
}

#[test]
fn retired_command_names_are_no_longer_registered() {
    let lib_source = include_str!("../src/lib.rs");
    assert!(
        !lib_source.contains("coding_workspace::coding_run_command"),
        "coding_run_command 应已由验证引擎取代"
    );
    assert!(
        !lib_source.contains("coding_workspace::coding_cancel_command"),
        "coding_cancel_command 应已由验证引擎取代"
    );
    assert!(
        lib_source.contains("coding::verification::coding_verification_run"),
        "验证引擎命令必须已注册"
    );
}

#[test]
fn workspace_commands_avoid_sync_fs_in_async_fns() {
    let source = include_str!("../src/coding_workspace.rs");
    // Collect the body of each `pub async fn` and assert it does not reach for
    // std::fs directly; those calls belong in spawn_blocking or tokio::fs.
    let mut offenders = Vec::new();
    for (index, line) in source.lines().enumerate() {
        if !line.contains("std::fs::") {
            continue;
        }
        let preceding: String = source
            .lines()
            .take(index)
            .rev()
            .take(80)
            .collect::<Vec<_>>()
            .join("\n");
        let in_async_command = preceding
            .lines()
            .find(|candidate| candidate.starts_with("pub async fn") || candidate.starts_with("fn ") || candidate.starts_with("pub fn "))
            .map(|candidate| candidate.starts_with("pub async fn"))
            .unwrap_or(false);
        let inside_blocking = preceding.contains("spawn_blocking");
        if in_async_command && !inside_blocking {
            offenders.push(format!("{}: {}", index + 1, line.trim()));
        }
    }
    assert!(
        offenders.is_empty(),
        "以下 async 命令内仍有同步文件调用：\n{}",
        offenders.join("\n")
    );
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test coding_workspace_async_test`
Expected: `retired_command_names_are_no_longer_registered` 与 `workspace_commands_avoid_sync_fs_in_async_fns` FAIL（旧命令仍注册、async 内仍有同步 IO）。

- [ ] **Step 3: 把扫描与搜索移入 spawn_blocking**

`coding_analyze_workspace` 改造模板（把原函数体整体搬进闭包，签名不变）：

```rust
#[tauri::command]
pub async fn coding_analyze_workspace(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<CodingWorkspaceAnalysis, String> {
    let root = access.require_workspace(&root)?;
    // The walk touches up to MAX_SCANNED_FILES entries with synchronous IO;
    // running it on a worker thread would freeze every other Tauri command.
    tokio::task::spawn_blocking(move || analyze_workspace_blocking(&app, &root))
        .await
        .map_err(|error| format!("工程分析失败：{error}"))?
}

/// Synchronous project scan. Emits partial results so a large repository shows
/// progress instead of appearing frozen until the whole walk completes.
fn analyze_workspace_blocking(
    app: &AppHandle,
    root: &std::path::Path,
) -> Result<CodingWorkspaceAnalysis, String> {
    // ... 原 coding_analyze_workspace 的函数体，去掉开头的 require_workspace ...
    // 在文件计数循环内每 2000 个文件推送一次进度：
    //
    // if file_count % 2_000 == 0 {
    //     let _ = app.emit(
    //         "coding://analysis-progress",
    //         serde_json::json!({ "scanned": file_count }),
    //     );
    // }
}
```

`coding_search_workspace` 同样处理：

```rust
#[tauri::command]
pub async fn coding_search_workspace(
    access: State<'_, FilesystemAccess>,
    root: String,
    query: String,
    is_regex: Option<bool>,
) -> Result<Vec<CodingSearchHit>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || search_workspace_blocking(&root, &query, is_regex))
        .await
        .map_err(|error| format!("代码搜索失败：{error}"))?
}
```

- [ ] **Step 4: 其余同步 IO 改 tokio::fs**

`coding_read_document`、`coding_write_document`、`coding_create_entry` 以及 `coding_git_diff` 内读取未跟踪文件的分支，把 `std::fs::read` / `write` / `create_dir_all` / `read_to_string` 替换为对应的 `tokio::fs::*(...).await`。示例：

```rust
    let bytes = tokio::fs::read(&safe)
        .await
        .map_err(|error| format!("无法读取未跟踪文件：{error}"))?;
```

- [ ] **Step 5: 下线旧命令**

从 `coding_workspace.rs` 删除 `coding_run_command` 与 `coding_cancel_command`，以及随之变成孤儿的 `CodingRunCommandRequest`、`CodingCommandResult`、`CodingCommandOutputEvent`、`collect_bounded_output`、`finish_output_capture`、`terminate_command_tree` 和常量 `MAX_COMMAND_CHARS`、`MAX_COMMAND_OUTPUT_BYTES`。

保留 `CodingProcesses`、`high_risk_command_reason`，并把 `strip_ansi` 改为 `pub` — 验证引擎需要它。

**实施时发现的偏差（已修正）**：被删除的 `collect_bounded_output` 带有两项 Task 4 遗漏的行为——ANSI 转义清理，以及**增量**内存上限（Task 4 原实现先全量缓冲再截断，冗长构建会把整份输出读进内存）。删除前必须先把这两项补进 `verification.rs`：新增 `push_bounded` 逐行裁剪、`label_dropped` 标注省略，并复用 `strip_ansi`。对应新增两个测试：`retained_output_is_capped_while_keeping_the_tail`、`short_output_is_not_labelled_as_dropped`。`coding_workspace.rs` 里原有的 `command_output_is_drained_but_retained_memory_is_capped` 测试随之删除，其覆盖已由上述两个测试承担。

从 `lib.rs` 的 `invoke_handler` 删除这两行：

```rust
            coding_workspace::coding_run_command,
            coding_workspace::coding_cancel_command,
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd src-tauri && cargo test`
Expected: 全部 PASS，含新建的 3 个 async 契约测试与 Task 1-7 的 50 个用例。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/coding_workspace.rs src-tauri/src/lib.rs src-tauri/tests/coding_workspace_async_test.rs
git commit -F - <<'EOF'
修复代码工作台后端的阻塞文件访问并下线重复命令

coding_workspace.rs 有二十余处同步文件调用直接写在 async 命令里，其中工程分析最多遍历一万二千个文件、十八层目录，搜索同样全量扫描，执行期间会占住 tokio 工作线程，导致刷新工程上下文时整个界面卡住。命令执行还与新的验证引擎重复，两套超时和取消逻辑并存。

- 工程分析与代码搜索整体移入阻塞线程池，签名保持不变
- 工程分析每扫描两千个文件推送一次进度事件，大仓库不再长时间无反馈
- 文档读写与目录创建改用异步文件接口
- 删除 coding_run_command 与 coding_cancel_command，命令执行与取消统一由验证引擎承担
- 新增契约测试：阻塞扫描不影响并发定时任务、已下线命令不得再注册、async 命令内不得出现同步文件调用
- 验证：cargo test 全量通过，含三个新增契约测试与前序七个任务的五十个用例
EOF
```

---

## Rust 侧完成检查

- [x] `cd src-tauri && cargo test` — coding 模块 54 个用例通过，契约测试 3 个通过，全量 451+ 用例通过
- [x] 前端未受影响 — 无前端文件改动；`tsc` 报出的两处错误在起点提交 `3a25c7c` 即已存在（`CodingWorkspacePage.tsx:1796` 与 `coding-workspace.test.ts:460` 的遗留 `"plan"` 模式），已在基线 worktree 上验证，与本次无关
- [x] 旧 coding 界面保持可用 — `coding_run_command` / `coding_cancel_command` 作为兼容层委托验证引擎，输出与取消均已保留

## 已落地的前端契约（Task 9-16 输入）

以下类型与事件已在后端确定，前端可直接复用。

**类型**：`TaskPhase`、`TaskNodeStatus`、`CodingTask`、`AcceptanceCriterion`、`TaskNode`、`TaskSummary`、`ChangeKind`、`FileChange`、`ChangeSet`、`VerificationKind`、`VerificationStatus`、`TestSummary`、`DetectedCommand`、`VerificationRecord`、`ProblemKind`、`ProblemSeverity`、`Problem`、`RepairOutcome`、`RepairRound`、`PhaseDecision`、`OrchestratorState`、`GateId`、`GateStatus`、`QualityGate`、`EvidenceEntry`、`DeliveryReport`。

序列化约定：结构体字段为 camelCase，枚举值为 snake_case。

**命令**（25 个，全部需 `root`，任务级命令另需 `taskId`）：

```
coding_task_list / create / get / delete / rename
coding_task_submit_requirement(planRequired) / approve_plan / rollback
coding_changeset_get / capture_baseline(dirtyFiles) / record_change(change)
coding_changeset_discard_file(path) / mark_reviewed(path)
coding_verification_detect / list / run(kind, command, timeoutSecs) / cancel(runId)
coding_diagnostics_list
coding_orchestrator_report_implementation / report_verification / state
coding_delivery_report / commit_input / pr_input
coding_git_commit(message)
```

**事件**：`coding://task-phase-changed`（含 `phase`、`reason`、`blocker`）、`coding://verification-updated`（整条记录）、`coding://verification-output`（`runId`、`stream`、`chunk`）、`coding://analysis-progress`（`root`、`scanned`）。

**待补写任务**：Task 9 前端骨架与主题、Task 10 命令面板、Task 11 tab 容器与编辑器、Task 12 活动栏视图、Task 13 Agent 面板、Task 14 底部面板与状态栏、Task 15 虚拟文档 tab、Task 16 切换与清理。
