# 桌面反馈修复与验证

本轮以 d9f45fbf（0.3.11）为源码基线，本地实现，不包含提交、推送或发布。视频安装包的 commit 未核实；源码缺陷与视频具体窗口归因分开记录。

## 变更与行为

| 反馈/缺陷 | 根因与实现 | 验证边界 |
| --- | --- | --- |
| 逐文件切换闪窗 | 固定 Git 1.95.3 的版本探测、通用 Git.spawn 缺少 windowsHide。校验原始 VSIX 后定点补丁，仅 Windows 注入隐窗选项，保留 cwd/env/stdio/取消参数及错误传播。构建、暂存、缓存复用、安装包验收均拒绝未修复入口。 | 实际 bundle 的 Windows/macOS/Linux VM 探针通过；具体原生窗口 PID 及 Windows 安装包行为待实机验收。 |
| 当前会话目录与下一任务目录混用 | ChatView 只接受实际会话 cwd，删除未来目录和切换目录回调。显示只读目录与明确的新建任务动作；Composer 的运行时命令、权限、目录相关操作使用当前 cwd。 | A 历史任务、B/C 新任务目标集成测试通过；C 创建请求及保存会话的 cwd 均正确。后端授权/一致性校验保留。 |
| 目录选择异常被吞 | 取消保持无操作；真实失败显示在菜单，保留有效目录且可重试，阻止重复打开对话框。路径美化仅用于显示。 | 取消、失败、重试、原始路径参数和 UNC/长路径显示测试通过。 |
| 重复焦点框与输入体验 | 通用 focus-visible 明确豁免已有外卡焦点的 textarea 和已有细线焦点的 splitter，其他控件保留兜底。高对比主题提供系统色焦点。空白点击聚焦避开交互控件和已有选区；IME 状态及 keyCode=229 不触发发送或菜单。 | 浏览器真实计算样式、键盘工具栏焦点、分隔条焦点通过。中文输入、草稿、附件相关组件回归通过；WebView2 原生 IME/选择仍需原生验收。 |
| 首页留白、长提示编辑空间 | 清理基础 CSS 的冲突首页约束；标题、输入框和选项作为整组在主内容区居中，宽度上限 880 CSS px；标题字号、圆角、阴影与留白重新配比。纵向自动外边距在内容超出窗口时归零，保留滚动可达性。ResizeObserver 处理侧栏拖动后输入换行高度。 | 64 组空白首页居中检查和 64 组长文本布局通过：八种视口（含 1280×600、2508×1648）×13/18 字号×深浅主题×侧栏展开/收起。没有横向溢出或按钮裁切。 |
| 桌面提醒发现性和状态 | “通知”一级入口直接打开提醒/渠道页。后端返回默认开启/显式配置/组织策略状态，系统权限明确未知。桌面独立开关、测试；高级渠道保留。禁删显式桌面记录避免删除后意外恢复 fallback；切换兼容旧记录并避免重复提醒。 | 配置持久化/重载、策略、旧记录、关闭与恢复、UI 错误/重试回归。原生投递与点击返回待签核。 |
| 测试通知与真实任务投递不同 | 设置测试可携带实际会话目标且后端验证会话。任务通知等待 OS 提交 ACK 后报告成功，点击等待留在后台，投递失败进入错误记录。 | “已向系统提交”不表示用户一定看到。带任务目标的 Windows/macOS 原生点击返回需要单独验收。 |
| 定时任务工作目录 | 保留原有选择器、保存和运行授权链，不重写已恢复的功能。 | 既有自动化选择/保存回归包含于全量组件测试；原生选择—保存—运行目录验收见 Windows 清单。 |

## Git 补丁资源证据

- 原始 VSIX SHA-256：`44909b81d3266860f02733c08475ab5fc66c0c1d7259b3c1b164e783559d9291`，归档与原 manifest 未修改。
- 原始 main.js SHA-256：`a71ea0092243bf1e86f47b69f3b2f8dba44dd041d801822ff9e605b67631f867`。
- 补丁：`vscode.git-1.95.3-windowless-v1`。
- 修复后的 main.js SHA-256：`32afd83c352e6590e25684dd4da58f0e4a7bee02b7a345ef4488e9bbe557f1cd`。
- 真实暂存目录 `src-tauri/resources/theia/browser/plugins/vscode.git/extension/` 含补丁入口及 `echoagent-windowless-patch.json` 来源记录。`runtime-platform.json` 含补丁版本和插件树指纹。
- `ide:prepare` 在确认补丁和树指纹后可复用暂存资源。修改补丁/管理/校验脚本会失效原构建缓存。未知版本、归档哈希、输入/输出入口、实际 manifest.main 或来源记录明确失败；重复补丁不会重复注入。
- Windows/macOS 构建脚本和 macOS 安装包资源验收入口包含校验。Windows 原生入口强制校验调用者给出的**安装目录**，没有开发资源回退。

## 实际验证命令

| 命令 | 结果 |
| --- | --- |
| `pnpm test --maxWorkers=4 --minWorkers=2` | 263 个文件、2624 项通过；最后的通知入口调整另定向回归。限制并发只控制资源占用，不过滤测试。 |
| `pnpm exec vitest run src/components/__tests__/SettingsPanel.test.tsx` | 29 项通过，包含一级通知入口、当前任务目标及事件收件箱切换。 |
| Composer/草稿/粘贴定向回归 | 77 项通过，包含新增 WebView2 229 Enter 处理。 |
| ChatView/SlashCommands 定向回归 | 32 项通过，包含 A 目录技能及快速切换后旧请求失效。 |
| `pnpm build` | TypeScript 与生产 Vite 构建通过。 |
| `pnpm test:scripts` | 44 项通过；进程生命周期测试在允许读取 ps 的本机权限下运行。 |
| `pnpm test:ide` | 21 项通过，含真实 VSIX、幂等、损坏拒绝、三平台 spawn 及 SCM 命令回归。 |
| `pnpm ide:build` / `pnpm ide:stage` | 完整构建及真实资源暂存通过，41 个 Theia 本地包、14 个插件、Node 22.14.0。 |
| `pnpm ide:verify-git` / `pnpm ide:prepare` | 暂存插件精确指纹通过；随后正确复用资源。 |
| `node scripts/validate-composer-feedback-ui.mjs` | 64 组居中检查、64 组长文本布局、工具栏/分隔条焦点、空值选择记录和桌面提醒交互通过；记录 CSS viewport 与 DPR。 |
| `node scripts/validate-design-system.mjs --controls-only` | 84 组 surface/state 观察通过，含深浅主题和字号。 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml -j 2` | 通过。 |
| `rustfmt --edition 2021 --config skip_children=true --check src-tauri/src/notifications.rs src-tauri/src/lib.rs` | 本轮 Rust 文件通过。 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 上一提交的其他 15 个 Rust 文件已有格式差异。本轮未做无关批量格式化；差异文件保持 HEAD 内容。 |
| `pnpm test:rust` | 881 项通过、5 项既有默认忽略、0 失败；包含新增桌面状态/持久化回归。测试使用独立临时数据根及项目自带 macOS 测试签名流程。 |
| 已签名测试程序 `--ignored --exact skills::runtime_tests::resident_skill_reload_smoke --nocapture --test-threads=1` | 已单独补跑默认忽略项中的真实 Runtime 技能烟测：1 项通过；覆盖常驻会话的项目技能新增、刷新、启停、删除。使用独立临时 ECHO_AGENT_HOME。 |

## 原生签核状态

- Windows 安装包：**未运行**。当前宿主为 macOS，VM 参数与浏览器回归不能替代 Windows 原生验收。
- 带任务目标的 Windows/macOS 原生通知投递、点击返回：**未运行**。
- 视频中的完整“两条黑框”：本次未复现，不声称已全部消失。空值占位蓝选的 WebView2 成因仍待记录原生 value/选区/焦点/组合输入状态。
- Windows 可运行验收入口、隔离数据、进程/窗口关联和人工清单见 [Windows 桌面反馈验收](windows-desktop-feedback-acceptance.md)。报告不会自动标记原生通过。
- 验证不改写用户真实会话、配置或工作区；无 Git 强制推送、提交、发布。Git 自动发现及交互终端实现保留。
