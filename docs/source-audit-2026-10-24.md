# 2026-10-24 源码审计与整改记录

## 基线与边界

- 仓库：`fuyuxiang/echo-agent-desktop`，分支 `main`。
- 开始 HEAD：`64e8d1a0e6c0567b4973a6b5ed1e1987e5f2b5d0`，工作区干净。
- 范围：自研前端、Rust 宿主、脚本、配置、文档、发行与 CI；vendored Runtime / Theia 审查宿主集成、项目补丁、协议与构建边界，不声称逐行验证全部上游实现。
- 审计与评审阶段未提交、推送、发布或同步其他仓库；后续提交与同步以用户明确授权和根目录约定为准。测试使用临时数据，不调用真实付费模型服务。
- 系统 Node 为 20.19.0；使用已有临时工具链 `/private/tmp/echo-package-toolchain/node-v22.23.4-darwin-x64/bin`。Rust 为 1.98.0。

## 审计覆盖与进度

| 模块 | 检查范围与入口 | 发现及处理 | 验证 | 状态 |
| --- | --- | --- | --- | --- |
| 前端与产品入口 | App、侧栏、能力导航、设置、快捷键、会话、项目 | 修复文档与微信竞态；清理退出产品入口的实现 | 最终 2,665 单测、完整九组 UI 与最终生产启动通过；追加知识库四布局交互通过 | 本轮范围完成 |
| Rust 宿主与 IPC | lib 注册、commands、bridge、存储、权限、生命周期 | 358 命令与前端静态调用核对；保留后台和兼容命令 | 格式、Clippy、常规 1,062 项及 5 项显式资源验收通过 | 本机范围完成 |
| Agent Runtime | ACP、会话、取消、权限与 MCP 注入、自研补丁 | 修复安全锁；未改推理、审批与持久化协议 | 宿主集成、真实 MCP 初始化与常驻技能重载通过；无真实推理请求 | 本轮范围完成 |
| 专家与专家团 | 成员、队列、恢复、工作区及记忆隔离 | 保留会话团队与专家团的独立职责 | 前端单测、Rust 状态测试、真实 Runtime + 本机模拟模型的专家团契约通过 | 本轮范围完成 |
| Echo Code / Theia | iframe 桥、进程、工作区、任务、Git、VSIX | 更新安全依赖，保留进程和未保存保护 | 构建、生产暂存、IDE 21、SDK/SCM 106、真实后端验收通过 | 本机完成 |
| Browser / Computer Use | 任务令牌、审批、路径和网络边界、原生模块 | 保留原生输入、任务授权与网络隔离实现 | 原生 125、guard 9+38、真实受控 Chrome 的观察/输入/跨页下载、恢复 UI 通过 | 本机范围完成 |
| 知识、文档、会议 | 本地索引、组织来源、Office worker、录音生命周期 | 修复 ZIP/表格读取、解析降级、预览预算误伤搜索，保留成果和录音存储 | 文档/知识库定向回归、真实 Excel 搜索/重建 UI、Office 和现有单测通过；未使用真实录音/ASR | 本轮范围完成 |
| 扩展、可选服务 | MCP、Skills、Plugins、组织、微信、通知 | 删除未接入的旧 MCP/策略原型；修复微信轮询 | 本地单测和安全 22 通过；真实账号/外部服务未验证 | 本轮范围完成 |
| 工程与测试 | package scripts、CI、测试隔离、发行、依赖补丁 | 补齐第五份锁审计；修复 Vite 退出、过期恢复 E2E 和 CI 漏接 | 五锁安全审计、版本、来源、Python、71 项脚本与退出回归通过 | 本轮范围完成 |
| 静态资源与实验模块 | 资源引用、experimental 边界、许可证 | 删除专属旧样式，保留共享菜单、图标、许可和隔离实验目录 | 最终引用图只剩三个明确保留的实验适配器未接入 | 完成 |

## 功能与验证映射

审计采用入口/引用图、IPC 注册核对、关键实现阅读、既有及新增行为测试相结合的方式。静态引用不等于运行可用；以下实机和外部服务限制另列。最初扫描 769 个 TS/TSX 文件（含测试），生产入口引用图触达 484 个文件；358 个宿主命令注册覆盖了前端 345 个不同的静态 IPC 命令。新增 `scripts/ipc-registration.test.mjs` 持续检查直接/别名导入的静态调用和重复命令注册，不代替 Rust 编译、参数类型或动态协议测试。

最终通过 TypeScript 的实际模块解析选项，对 498 个非测试、非声明 TS/TSX 文件的静态值导入/导出运行强连通分量检查，未发现同步模块循环；排除显式类型导入，未把动态 `import()` 或跨进程事件视为同步边。记录为 `eager-import-cycles.json`，不将其解释为异步业务链没有竞态。

| 功能 / 实际入口 | 前端、状态与宿主调用链 | 现有验证与重点 |
| --- | --- | --- |
| 首页、导航、设置、搜索 | `App.tsx` → `HomePage` / `Sidebar` / `PlaceholderPage` / `SettingsPanel`；会话和项目 store | `Sidebar`、`PlaceholderPage`、`App*` 单测；`validate-ui-surfaces.mjs`；确认懒加载、二级导航、快捷键和无效路由恢复 |
| 对话、模型与权限 | `Composer` / `ChatView` → `agent-client.ts` → `commands.rs` / `providers.rs` / `permission_config.rs` / `bridge.rs` → 进程内 ACP Runtime | `agent-client-interactions`、`ModelConnectionsPanel`、`permission-store`；Rust 命令与桥测试；权限在宿主/Runtime 执行点仍生效 |
| 暂停、停止、历史、分叉、恢复 | `session-control.ts`、`session-store`、`sessions-store`、`message-queue-store` → `agent_admin.rs` / `sessions.rs` | 会话、队列、状态持久化、分叉单测；`test:task-recovery`；检查双事件去重、会话切换与延迟响应 |
| 专家、会话团队、子 Agent | `experts-panel` / `TeamPanel` / subagent store → `agents_store.rs` / `team_mcp.rs` / `team_orchestration.rs` | 专家定义、团队进度、子会话导航、团队 UI；保留会话团队与持久专家团的不同职责 |
| 专家团 | 能力页签 / 侧栏 → `features/groups` → `groups/{mod,store,runtime,mcp,management}.rs` → SQLite + 独立原生执行会话 | `features/groups/__tests__`、Rust `groups/tests.rs`；创建、删除、重试、决定修订、成员上下文、并发和补充消息 |
| Echo Code、任务与 Git | `CodingWorkbench` / `TheiaIdeFrame` → task store / `tauri-api.ts` → `coding/*.rs` / `coding_workspace.rs` / `theia.rs` | `TheiaIdeFrame`、`CodingWorkbench`、任务 store、路径和审阅单测；检查 origin、iframe 身份、未保存保护、根目录切换和进程回收 |
| Browser / Computer Use | Composer 模式、任务控制与审批 → `automation-client.ts` → `automation/{mod,task,desktop_coordinator,browser,network_proxy,computer,accessibility}` | 原生模块及 guard 测试、网页输入测试；任务令牌、暂停撤销、审批、DNS/IP 固定、平台分支；本轮未让 Agent 控制真实应用 |
| MCP、Skills、Plugins | 能力导航 / 设置 → `LocalSkillsMcp` / `PluginsPanel` → `mcp.rs` / `skills.rs` / `skill_installer.rs` / Runtime 扩展 | 本地技能、能力状态、安装/卸载、插件 UI、归档安全测试；保留动态注册、包来源和权限契约 |
| 个人记忆与知识 | 设置记忆 / 知识库 / 项目来源 → knowledge stores / `kb-source-storage.ts` / `personal-knowledge.ts` → `agent_admin.rs` / `personal_knowledge.rs` / `org.rs` | 记忆导入、来源选择、知识上下文、组织边界和 hydration 单测；不合并全局偏好与按工作区隔离的事实 |
| 文件读取与成果 | 会话产物 / 工具详情 / 导出 → `FilePreview`、`zip-reader.ts`、`doc-preview.ts`、`artifact-catalog.ts` → `shell_fs.rs` / `session_artifacts.rs` / `document_export.rs` / `office_mcp.rs` → Office worker | 修复 ZIP 和表格真实格式；保留成果收据与授权；新增损坏/大表格降级、真实 JSZip 和越界回归 |
| 项目与定时任务 | 项目/更多菜单 → `projects-store` / `AutomationPanel` → `projects.rs` / `automations.rs` | 项目迁移、会话移动、后端 hydration、调度单测与 UI；宿主权威存储、前端缓存和恢复记录不作为重复实现删除 |
| 录音、会议与通知 | Composer / 录音页 / 设置 → meeting drafts、录音退出控制、通知渠道 → `meeting_capture.rs` / `meeting_minutes.rs` / `notifications.rs` | 会议草稿、退出保存、通知设置及 UI；本轮不录制真实麦克风、不调用 ASR/纪要付费服务 |
| 组织、远程与云存储 | 组织入口 / 设置消息通道、网络存储 → `org-session-store` / `WeixinChannelPanel` / `CloudStoragePanel` → `org.rs` / `weixin.rs` / `storage.rs` | 登录边界、WebDAV 选择/保存竞态、微信轮询测试；真实本机标准 WebDAV + 生产 Rust 操作/重启通过；不连接真实账号和远程工作区 |
| 更新、托盘、退出与备份 | About/更新设置、窗口/托盘事件 → `app_updater.rs` / `desktop_preferences.rs` / `lib.rs` / `backup.rs` | 更新 store、退出/恢复 guard、更新服务器 Python 测试、Rust 序列化及路径测试；不触发真实更新安装或注册系统自启动 |
| 工程、资源、发行与 CI | 根配置、`scripts/`、`deploy/`、`.github/workflows/`、`public/`、第三方 notices | 构建、格式、Clippy、锁图审计、Office、VSIX/SCM；源码 README 图标与运行时 public 图标有不同消费者，保留 |

## 基线与最终验证

原始 HEAD 的前端基线使用 `git archive HEAD` 在 `/tmp/echo-source-audit-20261024/pristine` 独立还原源码与配置，复用同版本依赖：UI 261 文件 / 2,694 测试全部通过；脚本 Vitest 6 文件 / 20 测试全部通过。最初直接在工作区启动的全套测试与新增用例、清理修改发生重叠，已中止，不使用该次混合结果作为基线。定向文档回归在修复前为 7 失败 / 32 通过；微信的两项时序用例在修复前失败，修复后通过。

本轮新增稀疏行展开的最终边界复核又发现：只限制单表行数时，多张工作表可以累计放大空行。已在交付前补全工作簿总行预算；同一解析器移除该守卫后，两个 `<row r="6000"/>` 实际展开 12,000 行，增加守卫后拒绝并走预览恢复路径，证据为 `workbook-row-limit.json`。新增跨表回归区分了本轮引入并已修正的风险与原始 HEAD 的坐标缺陷。

审计阶段完整命令输出位于 `/tmp/echo-source-audit-20261024/`；未提交评审后的最终追加复验位于 `/tmp/echo-review-fixes-20261024/`，下表用绝对路径标明追加日志。工具链 PATH 使用上文的 Node 目录，并优先放入 `/private/tmp/echo-package-toolchain/npm/node_modules/.bin`（npm 11.21.1）；浏览器验证显式设置 `PLAYWRIGHT_MODULE=/private/tmp/echo-group-browser/node_modules/playwright/index.mjs`，避免与 Theia 安装共享测试工具。中途为补齐边界整改而主动停止的前端测试/构建不计为通过。

| 验证项 | 结果 | 实际说明 / 日志 |
| --- | --- | --- |
| `pnpm build` | PASS | 追加修复后 TypeScript 与 Vite 生产构建通过，退出码 0；`/tmp/echo-review-fixes-20261024/build.log`。保留既有大型 chunk 提示，不隐藏警告 |
| `pnpm test` | PASS | 追加修复后的最终 261 文件 / 2,665 测试全部通过，退出码 0；`/tmp/echo-review-fixes-20261024/unit-full.log`。此前审计轮为 2,661，追加 4 项行为回归 |
| 定向回归 | PASS | 6 文件 / 85 测试：文档、真实 ZIP、损坏/大表降级、微信解绑/慢轮询、浮层及 IPC 注册；`targeted-final.log`。最终边界复核追加跨表总预算、授权操作竞态及解绑失败恢复后，相关 3 文件 / 68 测试通过，`final-boundary-regression.log` |
| `pnpm test:scripts` | PASS | 最终 71/71，含新增两项退出回归；追加复验 `/tmp/echo-review-fixes-20261024/scripts.log`。基线 69/69；沙箱内三项进程回收检查受 `ps` 限制，沙箱外全部通过，未修改测试来绕过限制 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | PASS | 基线失败，本轮格式修复后通过；`rustfmt-final.log` |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | PASS | 按最终安全锁图完成，退出码 0；`clippy-final.log` |
| `pnpm test:rust` | PASS | 8 个测试程序，常规总计 1,062 通过、0 失败、5 原有默认忽略；退出码 0，`rust-tests-final.log`。全部 5 项另行准备资源并显式运行通过，未改动 ignore 标记，见下一行 |
| Rust 资源型验收 | PASS | `isolated-smokes.json`：Runtime/MCP 初始化、常驻技能重载、受控 Chrome 观察/输入与跨页下载 4/4；`webdav-real.json`：真实 WsgiDAV 4.3.5 / Cheroot 11.1.2，9 项资源预检 + 21 项 Rust 检查，首轮与重启均退出 0，服务正常停止。均为独立数据目录、合成内容，无真实推理/账号调用 |
| `pnpm test:ui` | PASS | 九组顺序执行全部通过，退出码 0；包括文档、团队/专家团、插件、侧栏、372 项设计系统状态观察、64 组首页与 64 组长草稿布局、通知交互；`ui-current.log`。最终边界修复后再运行通用界面及文档读取四布局/键盘交互，均退出 0，`ui-surfaces-delivery.log` / `document-ui-delivery.log` |
| 追加知识库浏览器验收 | PASS | 真实 ExcelJS 文件、当前知识库/预览组件及页面容器，420/900 宽度 × 明暗主题四布局；正文搜索、缓存、键盘触发打开回调、超限预览提示、重建后继续命中，结果无横向溢出、无页面异常。`/tmp/echo-review-fixes-20261024/knowledge-browser/report.json`、同目录截图；临时复验脚本 `knowledge-browser.mjs`。不等同于调用系统 Office 打开文件 |
| `pnpm test:ui:coding-composer` | PASS | 16 种单行布局、菜单、草稿增高、实时字体调整、键盘/按钮提交及阻塞状态，退出码 0；`coding-composer-final.log` |
| `pnpm test:task-recovery` | PASS | 真实 Chromium 输入、下载、四布局自然语言续做，保持权限决定/模式不变并切换到新回合；`task-recovery-current.log` |
| `pnpm test:production-startup` | PASS | 追加修复后的最终构建产物 `passed:true`，只记录两项预期缺少 Tauri IPC 的错误，未注入原生成功响应；`/tmp/echo-review-fixes-20261024/production-startup.log` |
| `pnpm test:mermaid` | PASS | 54 组真实配置，包括原生 WKWebView 14 组，及预览、复制、下载、配置隔离、失败恢复；退出码 0，`mermaid.log` |
| `pnpm office:test` | PASS | 实际 docx/pdf/xlsx/pptx 导出、文字/公式缓存、图表关系、六页 PPT、无效输入与四格式保真；`baseline-office.log` |
| `pnpm test:security` | PASS | 22/22，包括五份锁的 Git 清单覆盖守卫、实际 body-parser 1.x / 2.x 的完整子进程回归；追加复验 `/tmp/echo-review-fixes-20261024/security.log`；旧版/新版各 5 次对照另见下节 |
| `pnpm security:audit` | PASS | 前端/IDE 源码/IDE 生产图均 0；全部五份跟踪 Rust 锁合计 1,831 种 registry 包版本、0 安全发现、24 停止维护提示；`dependency-audit-all-locks.log` |
| `pnpm ide:lock` | PASS | 用官方脚本重建 41 个本地 Theia 包的生产锁图；不手拼 lock |
| `pnpm ide:build`、`pnpm test:ide`、`pnpm ide:stage` | PASS | 源码完整编译；IDE 21/21；实际暂存 41 个包、14 个插件、Node 22.23.4；Git 生产资源摘要校验通过 |
| Theia SDK/SCM 与真实后端 | PASS | Mocha 106/106（真实 SDK 模拟模型的工具失败/中断/取消等）；生产资源的中文长路径、增量编辑、14 语言、预览、健康令牌/关闭检查通过，使用现有 Chrome |
| UI 验证服务退出 | PASS | 2/2 实际监听器与 HEAD 临时快照回收测试，未结束的 crawl-idle 不再阻塞公开 close；`ui-shutdown.log` |
| `pnpm test:native-guards` | PASS | 9 个 Node case + 38 个 helper guard case（合成报告/本地 Node fixture）；不等于真实桌面验收 |
| `pnpm test:desktop-native` | PASS | macOS Intel：125 通过、0 失败、2 原有忽略；沙箱外恢复 CoreGraphics 事件对象创建，未发送系统输入。同源的两个受控浏览器用例已在宿主资源验收中显式运行通过，仍分别保留 harness 的原始计数 |
| 更新服务器、版本及脚本 | PASS | Python 5/5；版本 0.3.11 一致；shell 语法、vendored 来源与完整性检查通过 |
| 跨平台实机 / 完整安装包 | 未运行 | 仅本机 macOS Intel；Windows / Apple Silicon / 签名安装包由现有 CI 矩阵提供可运行入口，本轮未远程触发发布或 CI |

安全扫描初次结果为 Theia 源码 9 个依赖/公告条目、生产图 2 个、Rust 4 个；升级后归零。最终五锁证据位于 `/private/var/folders/yj/cmk3vp190sdb502fg81sryxw0000gn/T/echo-dependency-audit-f61_v43v`。停止维护项单独保存在 `rust.json` 的 `maintenance` 中，不能解读为“所有依赖仍由上游维护”。

原始 HEAD 的 Vitest 两项目合计 267 文件 / 2,714 测试，最终为 261 文件 / 2,665 测试。数量减少来自删除 7 份仅服务于废弃实现的测试，同时新增 IPC 文件及文档、微信时序、异常恢复和知识索引用例；没有通过跳过生产功能断言制造通过，也没有把数量下降解读为覆盖率变化。生产引用图触达文件数保持 484，最终未接入的非图标生产候选仅剩三个有明确隔离说明的实验适配器。

## 未提交代码评审后的追加整改

评审确认了两项需要闭环的问题。追加证据统一保存在 `/tmp/echo-review-fixes-20261024/`；没有覆盖此前的审计基线，也没有新增 Rust 或依赖锁修改。

1. **表格预览预算误伤知识库搜索（P2）**：合法的小型 XLSX 只在 `A10001` 放一条事实，预览行限制就使原知识库提取返回 `null`，随后缓存该结果并表现为无搜索命中。新增回归先得到 2 项失败（`kb-before.log`）。知识索引现在通过 `extractSheetTextFromZip` 只遍历实际单元格，不分配坐标间的空行/列，并在追加共享字符串时立即执行原有每文件 524,288 字符预算；达到上限后停止后续工作表读取。预览仍保留工作簿行/单元格展开预算，ZIP 输入/解压限制也未放宽。修复后的文档与知识库 81 项通过（`kb-after.log`），包括 ExcelJS 生成的真实文件搜索、缓存、重建，末行/末列、实体和共享字符串重复展开。
2. **压缩请求安全回归不能区分漏洞版本（P2）**：原来的短 gzip 后缀在旧版也通过，不能证明公告修复有效。改用有效 gzip 帧、NUL 和 100 KiB 尾部触发真实未捕获错误；补充解析回调后分阶段发送 deflate 尾部、等待完整 HTTP 请求及保留另一条 SHA-256 消费者的断言。用同一 fixture 在 Node 22.23.4 对照：1.20.8 / 2.3.0 各 5 次均以未捕获 `Z_DATA_ERROR` 退出 1，1.20.9 / 2.4.0 各 5 次均通过全部场景；见 `parser-contrast.json` 与逐次日志。CI 仅使用项目实际安装的安全版本，并校验两套实现确实执行及完整成功输出；不把漏洞依赖加入项目。触发依据与复验入口见 [依赖安全维护](dependency-security.md)。

这两项修改让知识搜索与预览恢复各自按用途工作；高行号不会再被表现为“正文不存在”，文档超出显示能力时继续保留原件恢复入口。

## 问题与保留决策

### 已实施的修复

| 级别 | 问题与依据 | 实际整改 |
| --- | --- | --- |
| P1 | OOXML 的空目录/空文件使本地 ZIP 扫描 `break`；流式 ZIP 的 local header 没有大小而中央目录未读。真实 JSZip 的普通与流式输出均复现失败 | `zip-reader.ts` 用有界中央目录定位并核对 local header；无目录片段只接受明确大小。保留输入、条目、解压限额与路径检查，拒绝越界、加密和跨盘条目 |
| P1 | Excel `<c r="C3">` 原来只按出现次序 `push`，空单元格自闭合语法也被忽略，数值可移至错误表头下 | `doc-preview.ts` 保留显式行/列坐标、自闭合空格和间隔；整个工作簿共用 10,000 行、100,000 单元格展开预算（包括空行），单行最多 16,384 列；工作表按数字序排列。共享字符串只解码一层，XML 文本标签精确匹配 |
| P1 | 自定义文档读取器异常可从 `FilePreview` 渲染过程传播；新限额也必须有 UI 恢复路径 | 在文档读取和提取边界统一捕获异常，使用已有“打开原件”提示；不修改原文件或用户数据 |
| P2 | 预览的展开预算被知识库复用，合法高行号表格无法搜索 | 单独提取有界稀疏文本，保留原有文本容量和 ZIP 保护；真实 Excel 的搜索、缓存和重建回归通过 |
| P1 | 微信已连接状态的 interval 允许请求重叠，保存/撤销授权、解除绑定/卸载后旧结果仍调用 `setStatus` | `WeixinChannelPanel` 轮询增加 in-flight、effect 生命周期与操作代次保护，初次/手动状态读取也核对代次；授权修改在开始和结束时使旧读取失效，解绑后丢弃在途保存结果。三项补充授权时序用例修复前失败；新代次保护的解绑失败路径也在交付前复核并修正，避免锁住按钮。最终相关回归共 68 项通过 |
| P1 | 联网审计发现 Tokio、ctutils、body-parser、multer 及开发依赖新公告 | 两个 Rust workspace 精确更新 Tokio 1.53.3 / ctutils 0.4.4；Theia 同时更新源码和生产锁。body-parser 分别保留 1.x/2.x；Puppeteer 升同一 25.x；VSIX 开发工具的 Azure Identity 暂固定 4.13.0，满足调用方 `^4.1.0` 且不进入受影响的 MSAL 5–7.0，不强制覆盖到不兼容主版本 |
| P2 | IPC 注册易与大量前端封装漂移，现有 SCM 行为和 Office 验证未被日常 CI 完整接入 | 新增 IPC 注册守卫随 `pnpm test` 执行；日常 CI 加入 Office、已编译 plugin-ext 的 SCM 命令和固定 VSIX 验证；真实 body-parser 子进程覆盖 gzip 尾部崩溃、完整请求消费、保留其他消费者与后续请求，并以漏洞版本实测确认测试有效 |
| P2 | 安全审计自称覆盖工程锁图，实际遗漏 `scripts/desktop-native-check/Cargo.lock` | 纳入第五份锁，补 Git 跟踪清单守卫；去掉 fuzz 补丁校验对数组下标的隐式依赖；最终五锁联网审计通过 |
| P2 | UI 验证工具在结束时无限等待 Vite crawl-idle，已打印的通过信息或原始超时错误不能正确形成退出状态 | 使用当前 Vite 6 的公开 `close` 完成取消/回收，不先等待无界的 idle；真实监听器和 baseline 快照回收回归均通过 |
| P2 | 恢复 E2E 仍寻找旧“继续此任务”按钮，和已确认的自然语言续做产品流程、当前单测冲突 | 改测真实 Composer 发送新消息、拒绝状态提示、新回合切换及权限决定/模式未改变；清理无调用方的 `continuationPrompt` 旧按钮提示词助手。四种布局通过，不恢复已废弃交互 |
| P2 | Rust 格式基线不通过 | 按当前 rustfmt 修正 `lib.rs`、`session_artifacts.rs`、被宿主复用测试的 Runtime `desktop_delivery.rs`，不改上游算法 |

### 关键修改与回归位置

| 修改入口 | 对应回归与契约 |
| --- | --- |
| `src/lib/zip-reader.ts:36` 中央目录，`:97` 本地条目 | `src/lib/__tests__/zip-reader.test.ts`：普通/流式真实 JSZip、空目录、越界与解压限额 |
| `src/lib/doc-preview.ts:104` 表格坐标与总预算，`:217` 工作表路径与顺序 | `src/lib/__tests__/doc-preview.test.ts`：稀疏行列、共享字符串、实体、超限及跨表空行累计输入 |
| `src/lib/doc-preview.ts:232` 文本索引预算、`src/lib/local-kb-provider.ts:122` 接入 | `local-kb-provider.test.ts`：高行号/末列与真实 Excel 的搜索缓存重建；`doc-preview.test.ts`：截断共享字符串并停止预算外读取 |
| `src/components/FilePreview.tsx:126` 提取异常边界 | `src/components/__tests__/FilePreview.test.tsx`：损坏及大表降级，保留打开原件提示 |
| `src/components/WeixinChannelPanel.tsx:41` 初次读取，`:57` 已连接轮询，`:173` 起的授权操作 | `src/components/__tests__/WeixinChannelPanel.test.tsx`：慢轮询不重叠，保存/撤销及实际解绑后旧结果不覆盖 |
| `scripts/validate-task-recovery-ui.mjs:20`、`scripts/fixtures/ui-surfaces.tsx:527` | 真实 Composer 续做，新回合进入 streaming，未审批拒绝操作且未改变权限模式 |
| `scripts/ipc-registration.test.mjs:14` | 解析生产 TS 调用与 `src-tauri/src/lib.rs` 的实际 handler，随 `pnpm test` 执行 |
| `scripts/ui-review-runtime.mjs:79` 退出回收 | `scripts/test-ui-review-shutdown.mjs`：实际监听器关闭及 HEAD 快照清理，随 `test:scripts` 执行 |
| `scripts/audit-dependencies.py:65` 锁清单 | `scripts/test-dependency-patches.mjs:15` 跟踪锁清单守卫及 `scripts/fixtures/body-parser-recovery.mjs` 真实压缩请求恢复 |
| `.github/workflows/ci.yml:65`、`:305` | Office 与 IDE 插件/SCM 验证接入；本机已运行相同验证，未远程触发工作流 |

### 有证据的清理

- 删除 9 个无生产调用的实现：`MyFilesPanel.tsx`、`use-horizontal-scroll.ts`、`workspace-panel/{FileTreeContextMenu,Overlay}.tsx`、`coding/lib/ai-prompts.ts`、`coding/store/{clipboard-store,git-snapshot-store}.ts`、`lib/{policy-engine,mcp-capabilities}.ts`。
- 同步删除这批实现的 7 个专属旧测试文件，移除专用 `.myfiles-*`、`.overlay-*` 样式；全局浮层契约改为检查实际在用的 `AppDialog`。共享 `.context-menu` 仍被会话/专家团菜单使用，保留。
- `git log -S MyFilesPanel` 核实入口在 `2d3d06ea` 被明确移除；会话的 `ChatView` / `ToolSidePanel` 已承接成果展示、导出收据与打开授权，保留这些能力及持久化格式。没有重新引入已移除的一级产品入口。
- 旧 Git 快照/剪贴板/右键 AI prompt 已无消费者，实际 IDE 由 Theia 与任务审阅组件承接；旧前端策略“引擎”未参与安全执行，真实权威副本为 Rust `policy.rs`。旧 MCP capability 注册表从未接到 Runtime 初始化，不能以保留测试暗示已实现 sampling/elicitation 支持。
- 根项目 `react-router-dom` 没有源码、脚本或 Vite 配置引用；实际导航由 App 状态管理。用 pnpm 移除 manifest 并重建锁文件，不手改锁图。

### 保留及限制

- `src/experimental/` 的三个适配器有明确的隔离说明与边界测试；保留而不宣传为生产能力。
- 13 个未出现在前端静态调用集合的宿主命令包含原生验收入口、Provider 兼容 shim 和后台接口，不能据此删除。运行时工具/MCP 注册和平台条件编译均不要求首页 import。
- Runtime、Theia、GLib/LRU、updater、auto-launch、cpal 等 vendored 实现保留许可证、来源和既有安全补丁。此次 Theia manifest/锁图调整为新公告修复所必需；Runtime 的源码修改仅为被宿主复用测试的格式化。没有整体替换第三方源码。
- 本机为 macOS Intel (`x86_64`)。Windows、macOS Apple Silicon 的配置、条件分支与 CI 矩阵作静态核对，未声称完成其他平台实机验收。
- 内置推理/嵌入服务的 HTTP 地址是现存明确配置，README 已披露其网络与明文边界；本轮不擅自切换到未经部署验证的 HTTPS 服务。生产 TLS 入口与迁移需要服务端配合。
- 第三方停止维护公告与漏洞分开报告；未执行真实账号认证、远程付费服务、系统录音、更新安装、完整发行包的跨平台签名/安装验收。

## 剩余风险与外部验收

| 项目 | 级别 | 未完成原因与已做缓解 | 后续验收 |
| --- | --- | --- | --- |
| 内置推理、嵌入/重排服务仍为 HTTP | P1，现存部署风险 | `agent_runtime.rs` 绑定的现有服务没有已验证 TLS 入口，不能擅改协议导致核心功能中断；README 明确披露。个人模型支持 HTTPS，嵌入服务不继承个人模型密钥；敏感使用可关闭记忆并配置 HTTPS 模型 | 服务端部署有效 TLS 后共同验证证书、聊天、嵌入/重排与配置兼容迁移 |
| Windows / Apple Silicon / 完整签名安装包 | P2，未验证 | 当前仅 macOS Intel；保留平台代码、原生 guards 与发行 CI 矩阵，未假称其他平台实机通过 | 在各自平台执行原生/打包工作流，验证安装、更新、托盘、权限和退出 |
| 24 条停止维护提示 | P2，后续维护 | 最终公告扫描为 0 安全发现；停止维护提示未忽略，保留完整 JSON。部分依赖牵涉 GTK3、字体、托盘或 Runtime API，不能为减少提示强制替换主版本 | 按实际依赖链分批升级和做平台验收；持续运行联网审计 |
| Azure Identity 开发工具固定版本 | P2，维护跟踪 | 使用兼容且未受该公告影响的 4.13.0 / MSAL 3.8.10，完整锁图审计与 IDE 构建通过；不进入生产图，未验证真实 Azure 发布登录 | 上游 Identity 接入修复的 MSAL 后解除固定，并做真实开发账号验收 |
| 真实组织、微信、WebDAV 远端、录音/ASR 与模型服务 | 未做外部实测 | 为保护真实账号、数据和费用，仅运行本地/模拟服务、UI、协议与生命周期测试；本机标准 WebDAV 已完成生产 Rust 操作及重启验收，不能替代真实远端账号验收 | 由有测试账号和设备权限的环境执行对应实机流程；不得用本报告替代外部服务可用性验收 |
| 较大的前端依赖 chunk | P3，既有提示 | 生产构建仍提示 Monaco / Mermaid 等大包；已有懒加载和生产启动守卫，未放宽告警阈值 | 有实际启动性能测量后再做针对性拆分，避免破坏已修复的初始化依赖顺序 |

上述外部验收与部署事项保留，不描述为已整改或已通过。本记录的源码审计覆盖不等于全部第三方实现逐行证明，也不保证不存在尚未被发现的缺陷。
