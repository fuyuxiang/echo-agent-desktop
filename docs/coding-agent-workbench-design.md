# Coding Agent 工作台重构设计

日期：2026-09-11
状态：待评审

## 1. 背景与问题

现有「更多 → 代码开发」功能已实现约 4300 行前端与 1900 行 Rust，但存在结构性问题，导致体验达不到生产级：

**产品层**

1. 定位摇摆：同时存在「仿 VSCode 轻 IDE」与「Agent 工作台」两个产品，首屏 11 个并列导航入口（活动栏 4 + 底部 5 + Agent 面板 2 + 顶栏视图切换 2），无主次。
2. 用户显式选择被推翻：`inferCodingRequestIntent`（`src/lib/coding-workspace.ts:162`）用中英混合正则猜测读/写意图，命中 write 时推翻用户选择的 Ask 模式、切换 Craft 并新建会话（`CodingWorkspacePage.tsx:1025-1033`），导致会话上下文丢失。正则脆弱：「这段代码为什么要这样修改」同时命中 mutation 与 diagnosis 两组模式。
3. 验收标准与质量门禁是伪功能：`createAcceptanceCriteria` 在用户未填写时注入 5 条套话；`deriveQualityGates`（120 行）与 `buildVerificationReport`（130 行）已实现且有 8 个测试用例，但 `src/components/` 内零引用。
4. 流程断头：能 stage/unstage，不能 commit；无单文件丢弃、无 diff 内接受/拒绝改动；用户需切回终端手动提交。
5. 缺 IDE 基线：无快速打开（⌘P）、搜索不能替换、左右栏宽度硬编码（`238px` / `clamp(380px,30vw,500px)`）仅底部可拖；追问框 placeholder 承诺「@ 引用文件」但无 mention 实现。
6. 视觉三套体系冲突：`coding-workspace.css` 硬编码 `color-scheme: dark` 与 117 处 hex 色值、零 `[data-theme]` 适配；Monaco 锁 `vs-dark`（`CodingEditor.tsx:158,180`）；`CodingTerminal` 正确跟随 `data-theme`（`CodingTerminal.tsx:24,180`）。浅色主题下呈现「外壳浅 → 工作台黑 → 终端浅」。

**架构层**

1. `CodingWorkspacePage.tsx` 单文件 2128 行 / 105KB，50+ `useState`，含 8 个内联子组件。
2. 状态源分裂三处（localStorage 快照 / Zustand session-store / 组件本地 state），靠 `useEffect` 手工缝合；`autoResumeAttemptRef` 存在的唯一目的是压制重复恢复竞态。
3. localStorage 作业务持久化层：`saveCodingSnapshot` 实现两级降级裁剪（stdout 32KB → 2KB → 静默丢弃）；快照键按仓库路径单值（`snapshotKey`），一个仓库仅能存在一个开发任务。
4. 前端替 Agent 决策：意图路由（正则）、Ask 模式权限降级（`App.tsx:1183` 硬设 permissionMode 为 ask）、prompt 内 60 行中文执行协议（含用业务 prompt 修补工具 schema：「调用 list_dir 必须包含 target_directory」）。Agent 角色与权限策略两个正交概念被前端耦合。
5. 后端阻塞 IO：`coding_workspace.rs` 内 25 处同步 `std::fs::` 调用，仅 3 处 `spawn_blocking`；`coding_analyze_workspace` 在 async fn 内同步遍历最多 12000 文件 / 18 层深度。
6. 工程分析过浅但被当作上下文核心：按扩展名统计语言、将 manifest 所在目录当作「模块」、`dependencies` 恒为 `Vec::new()`（`coding_workspace.rs:1458,1470`），输出注入 prompt 的「当前识别的模块」并在 onboarding 展示为能力证明。
7. 命令执行双通道：工作台 `coding_run_command`（sh -lc / 180s / CI=true / `high_risk_command_reason`）与 Agent 的 `run_terminal_command` 并行存在，结果靠 `collectAgentValidations` 从消息流正则抽取后合并；两套超时、两套风险策略（前端 `checkCodingCommandRisk` + 后端 `high_risk_command_reason`）。

## 2. 目标与非目标

### 目标

- 交付生产级形态的 Coding Agent 工作台：界面无流程可视化，功能通过命令面板与对象下钻可达。
- 打通主链闭环：Requirement → Task → ChangeSet → Verification → Diagnostics → Repair → Gate → Delivery。
- 闭环由工作台硬编排（Rust 状态机），不依赖模型自觉遵守 prompt。
- 状态单一数据源下沉 Rust，支持一个仓库多个并存任务与中断恢复。
- 视觉跟随项目主题体系（`tokens.css`），浅色/暗色一致。
- 不影响项目其他功能。

### 非目标（第一期不做，界面留位并标注）

- tree-sitter / LSP 接入，因此清单第二章（AST、Symbol Index、Go To Definition、Find References、类型关系、继承/实现/Override、调用图、影响范围分析）第一期仅做到「模型自主搜索理解」水平。
- 依赖 AST 的 5.17 Symbol Rename、5.18 AST-aware Edit、14.10 Code Graph 驱动注释。
- 语义检索与向量索引（3.4、3.5 的 semantic 部分）。
- 容器沙箱（第十一章 11.1-11.7）、应用运行与 API 断言（第十章）。
- Git worktree 并行隔离（12.12）、多 Agent 并行执行（第十三章 13.3 及依赖项）。

## 3. 设计原则

三条原则决定了所有后续取舍：

**零流程可视化。** 专业工具（VSCode / JetBrains / Cursor）界面上没有阶段进度条。流程状态压进 24px 状态栏，与分支、问题数、行列号同等分量。流程只在需要用户决策时以卡片形式浮现（计划待批准、权限请求、修复卡住），事件驱动而非常驻仪表盘。

**命令面板承载功能。** 清单约 300 个功能点中约 200 个不应有可见入口。⌘K 全部命令、⌘P 快速打开文件、⌘T 符号跳转。功能增加不导致界面变胖。

**一切产出都是 tab。** 交付报告、Task DAG、工程画像、影响分析结果作为虚拟文档 tab 打开，与代码文件平级（对齐 VSCode 的 Settings / Release Notes 形态）。用户主动打开、自由排列、随手关闭。

## 4. 界面设计

### 4.1 布局

```
┌───────────────────────────────────────────────────────────────┐
│  echo-agent · main            [重构登录 ▾]        ⌘K   ⚙       │ 38px
├──┬────────────────┬───────────────────────────┬───────────────┤
│⌗ │ 资源管理器      │ auth.ts ×  ◈交付报告 ×    │ Agent         │
│⌕ │  ├ src         │ ─────────────────────────  │               │
│⑃ │  │ └ auth.ts ● │ 12  export async function │ ▸读取 auth.ts │
│⚑ │  └ tests       │ 13    const t = await…    │ ▸修改 +24-6   │
│⌸ │                │                           │ ▸测试 ✓42     │
│  │ 更改 3         │                           │ ┌───────────┐ │
│  │  M auth.ts     │                           │ │@ ⌸ Skills │ │
│  │  A auth.test   │                           │ │计划▢ 模型▾│ │
│  ├────────────────┴───────────────────────────┤ └───────────┘ │
│  │ 终端  问题 2  测试  输出  轨迹             │               │
├──┴────────────────────────────────────────────┴───────────────┤
│ ◐T4/7 ⚠2 ✓构建 ✗测试  main +142-38    12.4k·$0.31  UTF-8 TS  │ 24px
└───────────────────────────────────────────────────────────────┘
```

grid：`46px [可拖 238px] minmax(0,1fr) [可拖 380px]` × `38px minmax(0,1fr) auto 24px`。左右栏宽度可拖并持久化。

### 4.2 顶栏

- 左：仓库名 · 分支。
- 中：任务切换器 `[任务名 ▾]`。显示当前进行中任务，展开为本仓库任务列表（状态图标 + 任务名 + 进度），底部「+ 新建开发任务」。任务名由模型从需求首句生成（复用 `deriveTitle`）。
- 右：⌘K 入口、设置。返回按钮置于最左。

### 4.3 活动栏（5 项）

| 图标 | 视图 | 内容 |
|---|---|---|
| 文件 | 资源管理器 | 目录树、新建文件/目录、右键菜单 |
| 搜索 | 搜索 | 全文搜索 + 替换、正则、文件名过滤 |
| 更改 | ChangeSet | 本任务变更集、逐文件 diff、暂存/丢弃、提交 |
| 符号 | 符号 | 符号列表与跳转（第一期基于 Monaco documentSymbol，跨文件能力二期） |
| 上下文 | 上下文包 | 当前任务上下文清单、token 预算占用、手动增删 |

### 4.4 主区（tab 容器）

两类 tab 并存于同一容器：

- **文件 tab**：Monaco 编辑器 / diff 视图，含符号面包屑。
- **虚拟文档 tab**（前缀 ◈）：交付报告、Task DAG、工程画像、影响分析结果、调用图。由命令面板或对象下钻打开。

### 4.5 底部面板（可折叠，默认折叠）

终端（xterm PTY）、问题（结构化诊断）、测试（验证记录）、输出（命令输出）、轨迹（工具调用序列）。

### 4.6 状态栏

`◐T4/7 ⚠2 ✓构建 ✗测试  main +142-38    12.4k·$0.31  UTF-8 LF TS`

各段可点击：任务进度 → 打开 Task DAG tab；问题数 → 展开问题面板；验证图标 → 展开测试面板；变更数 → 切到 ChangeSet 视图；token/成本 → 展开用量明细（复用 `ContextUsagePill`）。

### 4.7 Agent 面板

- 执行流：复用 `ExecutionProcess`（工具调用、产出、追问）。
- 回复操作栏：复制 / 赞 / 踩 / 成本 · tokens · 耗时（数据源 `SessionUsage.costUsdTicks`）。
- 决策卡片：计划待批准、权限请求（`PermissionInlineCard`）、追问（`QuestionInlineCard`）、修复阻塞。
- 输入区：`@` 引用文件（复用 `InputAddMenu`）、图片、Skills；底部「先给计划」开关 + 权限选择器 + 模型选择器。

### 4.8 模式化简

现有 Ask/Code/Debug × direct/plan 六种组合，收敛为**单一「先给计划」开关**。角色判断交模型（删除 `inferCodingRequestIntent` 与 `resolveCodingModeForRequest`）。只读保证由 Runtime 权限模式提供，不由前端猜测意图后降级。

### 4.9 功能落位表

| 清单章节 | 落位 |
|---|---|
| 一 工作区与文件操作 | 活动栏「文件」+ 右键菜单 + Agent 工具 |
| 一.11-1.12 ChangeSet / 任务回滚 | 活动栏「更改」+ ⌘K |
| 二 AST/符号/引用/调用图 | 活动栏「符号」+ 右键菜单 + ⌘T（第一期受限） |
| 二.4 影响范围分析 | 右键菜单 + ⌘K，结果开成 tab（第一期受限） |
| 三 检索与上下文 | ⌘P / ⌘F / 活动栏「上下文包」 |
| 四 规划 / Task DAG | 状态栏任务进度点击展开；DAG 作为 tab |
| 五 代码生成与修改 | Agent 面板执行流 |
| 六 工具运行时 | 底部「轨迹」面板 |
| 七 构建/静态检查/测试 | 底部「测试」面板 + 状态栏图标 |
| 八 诊断中心 | 底部「问题」面板 |
| 九 修复引擎 | 自动执行；阻塞时浮卡片；历史在交付报告 |
| 十二 Git/提交/PR | 活动栏「更改」+ 提交按钮 |
| 十四/十五 注释与解释 | 右键「解释 / 生成注释」，粒度：函数/类/模块/系统 |
| 十六 质量门禁 | 交付报告逐条 + 状态栏图标 |
| 十七 Evidence | 交付报告内下钻 |
| 十八 交付报告 | 虚拟 tab，任务完成时提示打开 |
| 流程操作 | ⌘K：查看任务进度 / 批准计划 / 重跑验证 / 回滚任务 / 打开交付报告 |

### 4.10 视觉

- 全部色值改用 `tokens.css` 变量，删除 `color-scheme: dark` 与 117 处 hex，跟随 `[data-theme]`。
- Monaco 主题跟随 `data-theme` 切换（`vs` / `vs-dark`）。
- 终端已正确跟随，保持。

## 5. 架构设计

### 5.1 前端分层

新建 `src/features/coding/`，旧 `src/components/coding-workspace/` 在切换日整体删除。

```
src/features/coding/
├── CodingWorkbench.tsx          布局骨架（grid、栏宽、折叠）
├── store/
│   ├── workbench-store.ts       UI 态：tab 列表、栏宽、折叠、活动视图
│   └── task-store.ts            任务态镜像：订阅 Rust 事件，只读
├── shell/
│   ├── TopBar.tsx               仓库信息、任务切换器
│   ├── ActivityBar.tsx
│   ├── StatusBar.tsx
│   └── CommandPalette.tsx       ⌘K / ⌘P / ⌘T
├── explorer/                    文件树、搜索替换、ChangeSet、符号、上下文包
├── main/
│   ├── TabContainer.tsx
│   ├── EditorTab.tsx            Monaco + 面包屑
│   ├── DiffTab.tsx
│   └── docs/                    交付报告、TaskDAG、工程画像、影响分析
├── agent/                       执行流、决策卡片、输入区
├── panels/                      终端、问题、测试、输出、轨迹
└── commands/                    命令注册表（功能点 → 命令）
```

约束：每文件 < 400 行；子组件不内联；纯逻辑放 `lib/`，可单测。

### 5.2 状态模型

**单一数据源在 Rust。** 前端不再持有业务状态。

- Rust 侧持久化任务状态（沿用项目现有 JSON/JSONL 文件模式，与 `sessions.rs` 一致；不引入新依赖）。
- 前端 `task-store` 仅作 Rust 事件的只读镜像。
- 前端 `workbench-store` 仅持 UI 态（tab、栏宽、折叠）。
- 删除 localStorage 快照及其两级降级裁剪逻辑；删除 `autoResumeAttemptRef` 竞态补丁。

存储布局（`~/.echo-agent/coding/<workspace-hash>/`）：

```
tasks.json                任务索引（id、名称、状态、阶段、创建时间）
<task-id>/
  task.json               需求、验收标准、Task DAG、模式、模型
  changeset.json          文件变更集（含基线 Git 快照）
  verifications.jsonl     验证记录（构建/lint/类型/测试）
  diagnostics.jsonl       结构化诊断项
  repairs.jsonl           修复轮次历史
  evidence.jsonl          证据链（需求→任务→代码→测试→结果）
```

### 5.3 Rust 模块

| 模块 | 职责 | 对应清单 |
|---|---|---|
| `coding_task.rs` | 任务 CRUD、持久化、恢复、多任务并存 | 1.2、4.17、4.18 |
| `coding_orchestrator.rs` | 阶段状态机、闭环推进、门禁卡控、修复轮次 | 九、十六 |
| `coding_changeset.rs` | ChangeSet 记录、任务级回滚、用户改动保护 | 1.9-1.12、12.x |
| `verification.rs` | 命令识别与执行、结果结构化解析 | 七 |
| `diagnostics.rs` | 编译/语法/类型/lint/测试/依赖/配置错误解析 | 八 |
| `delivery.rs` | 质量门禁判定、交付报告、Evidence 聚合 | 16、17、18 |
| `coding_workspace.rs`（改造） | 工程分析、搜索、Git、终端；阻塞 IO 修复 | 2.1、3.1-3.2、12.1-12.5 |

### 5.4 编排状态机

```
Idle
 ↓ 提交需求
Planning ──（简单任务跳过）──┐
 ↓ 批准                     │
Implementing ←──────────────┘
 ↓ ChangeSet 非空
Verifying ──全绿──→ Gating ──通过──→ Delivered
 ↓ 有失败                      ↓ 不通过
Diagnosing                   Blocked
 ↓
Repairing ──（轮次 < N）──→ Verifying
 ↓ 轮次耗尽 / 重复错误 / 新错误
Blocked
```

规则：

- 阶段推进由 Rust 判定，不由模型自述。
- 验证结论只信退出码与结构化解析结果。
- 修复轮次上限可配（默认 3）；命中重复错误（同一诊断指纹连续出现）或新错误（修复后诊断集扩大）立即转 Blocked。
- 门禁不通过不得进入 Delivered。
- 任何阶段可中断，重启后从持久化状态恢复。

### 5.5 前后端契约

Tauri 命令（新增）：

```
coding_task_list / create / get / delete / rename
coding_task_submit_requirement      提交需求，进入编排
coding_task_approve_plan            批准计划
coding_task_rollback                任务级回滚
coding_task_rerun_verification      重跑验证
coding_changeset_get / discard_file / stage / commit
coding_commit_message_generate      生成提交信息
coding_pr_description_generate      生成 PR 描述
coding_delivery_report              交付报告数据
coding_diagnostics_list
```

事件（Rust → 前端）：

```
coding://task-phase-changed
coding://changeset-updated
coding://verification-updated
coding://diagnostics-updated
coding://repair-progress
```

### 5.6 命令执行统一

删除工作台自有的 `coding_run_command` 双通道，统一走 `verification.rs` 一条路径：单一超时策略、单一风险策略（后端 `high_risk_command_reason` 为唯一裁决点，删除前端 `checkCodingCommandRisk` 的重复判断）。Agent 的 `run_terminal_command` 结果由 orchestrator 直接消费，不再靠 `collectAgentValidations` 从消息流正则抽取。

### 5.7 后端阻塞 IO 修复

- 25 处同步 `std::fs::` 改为 `tokio::fs` 或包进 `spawn_blocking`。
- `coding_analyze_workspace`、`coding_search_workspace` 改为流式增量返回（事件推送部分结果），避免全量遍历阻塞 UI。

### 5.8 Prompt 瘦身

- 删除工具 schema 补丁条款（「调用 list_dir 必须包含 target_directory」等），移至工具定义层。
- 删除前端 60 行中文执行协议中由 orchestrator 硬约束的部分（阶段推进、验证要求、门禁）。
- 保留：工程规则引用、上下文包、用户改动保护、最小修改原则。

### 5.9 隔离保证（不影响其他功能）

- 新增代码全部在 `src/features/coding/` 与新 Rust 模块内。
- 挂载点仅 `PlaceholderPage.tsx:180` 的「代码开发」分支。
- 不修改 `App.tsx` 主聊天链路、不修改共享 store 现有字段、不修改其他面板。
- 共享组件（`ModelSelector`、`PermissionPicker`、`ExecutionProcess`、`InputAddMenu`、`ContextUsagePill`、`Markdown`）只读复用，不改签名。
- 新样式限定在 `.coding-workbench` 作用域内，不引入全局选择器。

## 6. 第一期范围

### 交付内容

1. 界面骨架：布局、可拖栏宽、任务切换器、命令面板（⌘K/⌘P/⌘T）、状态栏、tab 容器、主题跟随。
2. 任务管理：多任务并存、持久化、中断恢复。
3. ChangeSet：变更记录、逐文件 diff、暂存/丢弃、任务级回滚、用户改动保护。
4. 编排闭环：Generate → Build → Test → Diagnose → Repair → Regression → Gate。
5. 验证引擎：构建/lint/类型检查/测试命令识别与执行，结果结构化解析（JUnit / pytest / Jest / Vitest / cargo / tsc / eslint）。
6. 诊断中心：错误结构化为 `Problem{file,line,symbol,kind,message}`，问题面板，Problem → File/Line 跳转。
7. 修复引擎：自动修复循环、轮次控制、重复错误检测、新错误检测、Blocker 识别。
8. 质量门禁：接线已实现的 `deriveQualityGates`；Build/Test/Lint/TypeCheck/DiffReview/Acceptance 门禁。
9. 交付：commit（含提交信息生成）、PR 描述生成、交付报告 tab、Evidence 链路。
10. 规划：Task DAG tab、任务依赖与顺序、验收标准结构化、Task 状态管理。
11. 解释与注释：函数/类/模块/系统四粒度，右键入口；Mermaid 图输出到报告 tab。
12. 技术治理：文件拆分、状态源统一、阻塞 IO 修复、命令执行统一、prompt 瘦身、Monaco 主题联动。

### 界面留位但标注二期

活动栏「符号」视图、右键菜单中的「查找引用 / 调用链 / 影响范围」、调用图 tab。第一期这些入口存在但功能受限（基于 Monaco 单文件符号或模型搜索），tab 内明确标注能力边界，不伪装为已完成。

## 7. 测试策略

- 纯函数单测：阶段状态机转移、诊断解析器（各语言样本输出）、门禁判定、ChangeSet 差异计算、命令识别。
- Rust 集成测试：任务持久化与恢复、回滚正确性、修复轮次终止条件、并发修改检测。
- 前端组件测试：命令面板过滤、tab 容器行为、状态栏交互、决策卡片渲染；沿用现有 `CodingWorkspacePage.test.tsx` 中仍适用的 15 个用例并迁移。
- 回归验证：确认主聊天、自动化、专家、知识库等其他面板功能未受影响。

## 8. 风险

| 风险 | 应对 |
|---|---|
| 诊断解析器覆盖语言有限，误判验证结果 | 解析失败时退回退出码判定，并在 UI 标注「未结构化解析」 |
| 修复循环消耗大量 token | 轮次上限 + 重复错误检测 + 状态栏实时成本显示 + 可随时中断 |
| 编排状态机与 Runtime 事件时序错配 | 状态机以持久化状态为准，事件仅作触发；重启可恢复 |
| 第一期无 AST，上下文精度依赖模型 | 上下文包视图可见可手动增删；二期接 tree-sitter |
| 旧任务数据迁移 | localStorage 快照一次性导入为新格式任务，导入后清理 |
