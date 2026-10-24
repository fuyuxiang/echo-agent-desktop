# 桌面控制验证记录（截至 2026-10-24）

本次默认交付本地改动，未提交、推送、同步远端或发布安装包。本轮继续在已有改动上完成；未回退之前工作。历史记录保留，最新结论以顶部验收为准。

## 评审修复后的源码回归（2026-10-24）

本轮修复用户意图误授权、退出自动化进入计划模式时的工具恢复、原会话定制配置及动态记忆/历史工具保留、自然语言续做、路径与文件名补充、完整动作回包预算、Windows 应用别名，以及短引用证据校验。暂停状态提供可选的一次续做入口；生成间隙可以暂停，停止、重启、验收期限与请求失败分别解释。发送新指令替换当前轮时同步撤销旧的实体操作授权。

| 检查 | 本轮结果 |
| --- | --- |
| 前端全量 Vitest | 267 个测试文件、2,714 项通过 |
| TypeScript 与 Vite 生产构建 | 通过；保留原有的大 chunk 提示 |
| `pnpm test:scripts` | 69 项通过；进程树断言需在允许 `ps` 的环境执行 |
| 直接引用生产源码的原生测试 | 125 项通过，2 项真实设备权限诊断默认忽略；CoreGraphics 事件对象断言在沙箱外执行，没有派发输入 |
| Windows `x86_64-pc-windows-msvc` 原生模块检查 | 通过；包含系统本地化应用版本资源与可执行文件别名 |
| 完整主程序 `cargo check --lib` | 通过；最后的 Runtime 动态工具恢复也已由主程序测试目标完整编译 |
| 主程序自动化 / 元数据回归 | 125 项通过、2 项真实浏览器诊断默认忽略；元数据 14 项通过 |
| MCP 身份与会话授权边界 | 2 项通过；核对注册的 automation 服务身份及会话绑定 |
| 真实主程序 ACP Runtime 模式恢复 | 1 项集成测试通过，覆盖电脑/网页 → 计划/询问/默认六条路径；严格比较恢复前后的工具库存，包含会话动态记忆与历史工具；未发送模型推理或桌面输入 |

本轮自动化回归不等于重新完成真实 GUI 保存任务；以下耗时、调用数、二进制哈希均属于评审前的独立实测构建，保留历史证据，不能作为当前源码已经实跑的证明。Windows 实机仍未验收。

## 评审前文件面板与引用性能验收（2026-10-24 12:04，北京时间）

最终构建由配置中的 **MiniMax-M3.1-Flash** 通过真实 Runtime、正常输入框、macOS 原生控件与必要截图完成。源可执行文件和实际运行的签名拷贝均已核对 SHA256；独立核验通过后停止专用验收实例，保留 TextEdit、Safari 及文件。该轮源码与当时实跑构建一致。

| 相同真实任务 | 上一轮 Ns82Mz | 最终 nzpXSF |
| --- | ---: | ---: |
| 新建、输入、暂停、自然语言继续和保存 | 116.978 秒 / 28 次调用 | **48.653 秒 / 9 次调用** |
| 正文精确读回 | 20.678 秒 | **19.998 秒** |
| 继续后至完成 | 90.640 秒 | **22.969 秒** |
| 主任务失败 / 过期引用 | 3 / 2 | **0 / 0** |
| 保存面板打开快捷键派发 | 2 | **1** |
| Safari 新标签页、本地页面输入和文件选择 | 362.252 秒 / 40 次调用 | **82.821 秒 / 15 次调用** |
| Safari 截图 / 续页 / 独立观察调用 | 7 / 5 / 9 | **1 / 0 / 0** |
| Safari 失败 / 过期引用 | 2 / 1 | **1 / 1** |
| 桌面 / Runtime 确认卡 | 0 / 0 | **0 / 0** |

Safari 耗时减少 **77.1%**、调用减少 **62.5%**；输入保存任务耗时减少 **58.4%**、调用减少 **67.9%**。计时包含模型、工具、最终核验与主任务 5 秒暂停静默检查。统计按完整 Runtime journal 汇总，纳入失败及客户端/传输拒绝，未返回的调用不计完成；工具 schema 搜索单列。工具调用减少主要是减少模型往返，文件面板复合操作仍包含真实键盘和原生读回步骤。

最终轮先执行本次新建命令，在空文稿写入该轮唯一正文，精确核对 29 个 Unicode 字符 / 69 字节 / 两个 LF。用户消息“停一下”撤销执行授权，确认 5 秒无实体操作；“继续保存”恢复同一任务，系统面板保存后文件逐字正确，原生文档 URL 匹配。浏览器页面实际读入输入值及所选文件字节后，才显示 `ECHO-CROSS-PASS-nzpXSF`；实际 Safari 窗口/页面观察读到该标记。两个模型任务均自然 end_turn。

**边界与剩余纠正：**保存面板没有重开，三次 `computer_file_dialog` 准备均成功（保存、本地文件打开、网页文件选择）。Safari 在页面载入后的窗口上下文改变时拒绝过期控件一次，模型刷新当前状态后续做；第一次正文输入读回少一个末尾字符，模型核对到不一致后重新输入并验证成功。故本轮仍有 **1 次引用刷新、1 次输入读回重试**，不声称零重试或所有应用稳定。最终保存文件和网页成功标记均已独立核验，未将未核验派发当成功。

中间轮 `W8j6hB` 也保存及跨应用通过：Safari 182.239 秒，但主任务 214.555 秒退步。该轮包含冷启动，且模型对格式命令反复判断，截图坐标、等待时间和组合键传输格式造成重试。保留这轮证据，修正公共参数解析及菜单上下文指引后再运行最终构建；不以最终快样本覆盖中间退步。单轮结果不是稳定分位数，也不代表冷启动时延保证。

通用实现按系统控件身份处理文件面板，不含 TextEdit/Safari 名称分支：

- `computer_file_dialog` 在已打开的标准系统面板内完成路径导航、键盘输入、精确读回、回到原面板及保存文件名填写；每步可取消，不打开/重开面板，不替代文件写入。准备后模型依据返回控件直接提交并核验，全流程无需用户额外操作。
- 紧凑上下文优先返回输入、可操作控件和内容，省略空结构容器并标记覆盖边界，完整结构保留 snapshot 入口。
- 短引用只在新观察确认同一原生对象、未变内容及原窗口/文档上下文后复用；内容、文档、目标、暂停及会话变化继续失效，不按标签猜测替换目标。
- 应用内部的当前窗口用于后台应用定位；前台焦点另行验证。菜单记录所属窗口和是否已核对前台，采用最新已观察命令的实际动作标签。
- 公共数字入口兼容已观察到的数字字符串，仍按有限数字和有符号/无符号整数校验；修饰键兼容有限层级的数组封装及单值，并对组合键使用同一校验。没有解析文本、引用或布尔值来推断执行权。

原生生产模块测试 **114 通过 / 2 项硬件诊断默认忽略**，证据与计时检查 **23 通过**；Windows 原生模块编译检查通过。本轮未改前端；Windows 实机、自绘文件面板及更多应用未据此认定通过。

证据：[最终独立核验](latest-task-flow-verification.json)、[两阶段完整比较](latest-performance-comparison.json)、[构建与源码指纹](latest-performance-provenance.json)、[上一轮独立核验](file-dialog-baseline-task-flow-verification.json)。原始 Runtime 日志和中间轮产物保留在对应的私有验收目录；仓库不复制模型密钥、配置或完整桌面截图。

## 前一轮通用执行性能验收（2026-10-24 11:18，北京时间）

最终源码已在配置中的 **MiniMax-M3.1-Flash** 上通过真实 Runtime、正常 Composer 和系统原生桌面验收。验收实例随后停止；当前构建、实际运行的签名拷贝哈希均已核对。没有提交、推送或同步远端。

| 相同输入、保存、暂停与继续任务 | 基线 GLOuNl | 当前 Ns82Mz |
| --- | ---: | ---: |
| 总耗时（含 5 秒暂停静默检查与最终核验） | 520.273 秒 | **116.978 秒** |
| 精确正文读回 | 90.596 秒 | **20.678 秒** |
| 自然语言继续后至完成 | 424.115 秒 | **90.640 秒** |
| 电脑工具返回次数（含失败） | 70 | **28** |
| 失败调用 | 4 | 3 |
| 截图 | 11 | **0** |
| 独立应用/窗口发现 | 19 | **1** |
| 保存面板打开快捷键派发 | 2 | 2 |
| 错误的副本快捷键 | 1 | **0** |
| 桌面/Runtime 确认卡 | 0 / 0 | **0 / 0** |

总耗时减少 **77.5%**，电脑调用减少 **60%**。统计只比较第一项任务；另有 2 次工具 schema 搜索，不隐藏失败调用，也不把 Safari 时间计入输入保存指标。数据来自原始 Runtime journal 和正常界面事件，代表单次严格通过样本，不代表稳定分位数。

当前轮确实先执行新建命令，随后在空编辑区通过真实原生键盘输入。本轮独有正文为 29 个 Unicode 字符 / 69 字节，含两个真实 LF；暂停撤销执行授权并静默 5 秒，一句“继续保存”恢复同一任务。系统保存完成后，文件内容与原始请求逐字相同，原生文档 URL 与请求路径一致。模型两个任务均自然 `end_turn`，未以测试取消充当完成。

同一版本另由正常输入框发起 **Safari 新标签页 → 本地合成页面输入 → 更新结果 → 系统文件选择器选择刚保存的文稿 → 页面实际读取文件内容**。页面只在输入和文件字节都正确时显示 `ECHO-CROSS-PASS-Ns82Mz`；实际 Safari 原生窗口/页面观察读到该标记。该任务 **362.252 秒 / 40 次电脑调用**，也无需确认卡。未通过 Shell、脚本、文件写入或 CDP 代做目标操作；测试脚本仅准备合成页面、提交普通用户消息和记录证据。

**仍有重试：**第一项任务的 3 次失败分别为两次过期控件引用和一次请求外路径核验（被范围校验拒绝）；保存面板仍重开一次。因此本轮解决了主要耗时与大量发现/截图往返，不能声称“零重试”或所有应用已稳定。Safari 的多层文件选择仍慢，单项耗时已独立列出；Windows 仅有编译检查。

通用实现包括一次应用/窗口/控件/菜单上下文、操作后的紧凑状态返回、实际菜单快捷键、保留并重验应用/窗口身份、仅重读观察的瞬时超时恢复、缺少父链时的实时原生树归属验证，以及严格的 MiniMax 数组封装兼容。产品执行代码没有针对 TextEdit 或 Safari 的保存流程分支。

当前检查：生产原生模块 **105 项通过 / 2 项硬件诊断忽略**；验收与审计脚本 **19 项通过**；Windows `x86_64-pc-windows-msvc` 交叉检查通过；独立应用构建通过。此前界面 87 项、TypeScript/Vite 检查仍是上一轮结果，本轮没有修改界面组件。

- [完整通过证据](latest-task-flow-verification.json)
- [性能对比（含失败与分项调用数）](latest-performance-comparison.json)
- [程序哈希、源码指纹与停止记录](latest-performance-provenance.json)
- [通用优化说明及重现命令](performance.md)

原始材料：`/private/tmp/echo-native-review-controls-Ns82Mz`，会话 `01a16be2-822a-7eb3-9e8c-d508edb0c2f1`。实际文件：`workspaces/default/native-control-fixtures/task-flow-output.txt`，SHA256 `af6fc53eca2ff943a50632b9bde8c6c1100367732d2481bc20c16a10cce2254d`。此前三轮合成文稿内容均保留并核对。

迭代记录：VTmqPB 冷启动调查未完成；G3lCzu 虽于 146.082 秒保存，但没有显式新建命令，严格审计不通过，未纳入最终通过；7o1H3P 已通过两应用全流程，但作为父链/数组修复前的中间版本保留。最后以 Ns82Mz 的当前二进制重新完成验收，没有使用早期较快但条件不合格的轮次作为最终成绩。

## 上一轮任务驱动重构与基线（历史记录）

当前自动化检查：生产原生模块 94 项通过、2 项硬件诊断默认忽略；Windows x86_64-pc-windows-msvc 交叉检查通过；任务观察器与证据脚本 16 项通过；界面 87 项、TypeScript 与 Vite 构建通过。主应用宿主测试分别为 meta 13 项、automation 90 项与两项 Runtime/授权边界测试通过（该主应用批次早于最后的同层优先读取修正；修正由最新生产源码的 94 项专用测试覆盖）。这些统计均不替代下面的真实任务验收。

用户已明确撤销默认逐次审批设计。当前普通电脑任务由直接用户请求授权，观察、原生操作、截图后备、输入和保存不再逐步询问；可信聊天入口处理“停一下”和“继续保存”，正常界面移除专用电脑控制工具栏。以下早期记录中的逐次审批要求属于历史版本，不能作为当前产品行为。

### 上一轮真实验收：通过（性能基线）

2026-10-24 05:06（北京时间），`MiniMax-M3.1-Flash` 在独立 `EchoAgent Controls.app` 中完成了正常 Composer 发起的三条消息：原始任务、“停一下”、“继续保存”。没有点击电脑模式、恢复、授权或确认按钮，没有直接 IPC 代授/恢复，也没有用 Shell 或文件写工具生成目标文稿。

- 实际新建独立空文稿，转换为纯文本，经原生控件键盘输入并准确读回本轮唯一正文。
- 暂停后电脑授权撤销，确认取消后观察 5 秒，无后续实体操作；自然语言继续在同一会话建立新令牌并续做。
- 使用系统保存面板完成实际保存。原生控件为主要路径；目录候选项命中检查未通过时，使用新的真实截图双击后备，由模型自行选择路径。
- 桌面确认卡 **0**，通用 Runtime 权限卡 **0**。模型最终以 `end_turn` 自行结束，验收器没有通过取消或暂停制造完成事件。
- 实际文件 **69 字节 / 29 个 Unicode 字符**，正文与原始请求逐字一致（含末尾 1 个 LF）；原生 `documentUrl` 与请求路径一致。文件 SHA256：`7acbaf68b95448022870674d8202a7fd245c5e36d3c1a91100878e534676ac37`。

实际产物：`/private/tmp/echo-native-review-controls-GLOuNl/workspaces/default/native-control-fixtures/task-flow-output.txt`。原始日志与完整运行证据保存在 `/private/tmp/echo-native-review-controls-GLOuNl`，会话 `01a16a8d-9dc6-7760-9e85-1013f352e6f5`。本仓库中的 [机器可读核验结果](latest-task-flow-verification.json) 保存源二进制/签名二进制哈希、模型、原始会话和最终文件指纹。

本轮从 `2026-10-23T20:57:07.706Z` 到 `2026-10-23T21:05:47.979Z`，约 **8 分 40 秒**，有 66 次返回已完成状态的电脑工具调用，另有 4 次失败调用。模型曾误用副本快捷键、目录 Return 路线，并遇到过期引用；这些均在同一轮内自行处理。**功能流程通过，但速度与一次完成率仍需优化，不能据此宣称任意应用的操作都已稳定。**本轮覆盖 macOS TextEdit 的输入、保存、暂停和自然语言继续；Windows 仍只有编译检查，没有本轮实机验收。模型回合结束后会话保留任务范围，正常界面隐藏运行进度，暂停/停止/重启仍撤销执行授权。

独立判定命令：

```sh
src-tauri/resources/theia/node/bin/node scripts/verify-native-desktop-task-flow.mjs /private/tmp/echo-native-review-controls-GLOuNl
```

核验器独立读取原始 Runtime journal、实际文件与原生文档 URL，要求本轮新建与空编辑区输入、唯一正文、零确认、暂停静默、同任务继续及自然结束。早期失败轮次未计入通过。

已排查并修正的真实阻塞包括：重复的 Runtime/桌面授权、聊天与电脑分别暂停、错误工具名进入通用审批、系统保存面板挂在原窗口却被误判为不可访问、深度优先控件读取让文件列表先耗尽预算而遗漏浅层按钮、双击未设置 macOS click-state、把完整路径当成文件名，以及正文核验参数遗漏终止换行。引用/焦点/取消保护保留，未通过放宽旧截图寿命解决问题。

## 早期验收条件（历史权限模型，已由任务驱动默认策略替代）

- 真实系统后端发现应用/窗口，返回有身份约束的会话引用；激活后确认前台身份。
- 快照/查找返回原生角色、名称、值、状态、边界、动作和截断信息；同名歧义与不完整搜索不默认选首项。
- 原生写操作经过现有独立确认；批准后目标发生变化、引用跨会话、应用退出、受保护/禁用/只读时不输入。
- 中文、多行、特殊字符和长文本写入后实际读回；成功派发不等于任务已完成。
- 暂停取消排队和审批，返回暂停后不再派发输入；两个会话不同时控制实体桌面。
- 文件选择/保存、长文滚动、跨应用连续流程使用合成数据，保留真实界面证据和独立文件检查。
- 至少一个真实 EchoAgent Runtime 任务发现、调用新增工具、收到真实结果；不能以直接 HTTP、Mock 或独立脚本冒充。
- macOS 与 Windows 分别记录编译、自动化和真实桌面结果；交叉编译不替代 Windows 实机。

## 已执行命令

| 命令 | 当前结果 |
| --- | --- |
| `cargo check --manifest-path src-tauri/Cargo.toml -j 2` | 第一轮 macOS 主项目检查通过；随后有继续修改，最终构建另列 |
| `cargo test --offline --locked --manifest-path scripts/desktop-native-check/Cargo.toml` | 最新 53 项通过，1 项真实权限诊断默认忽略；含可选标签/值不可读、面板父链校验、独立查找引用、shortcut 参数和续页有效期；直接引用生产源码，无替代生产后端 |
| `cargo check --offline --locked --manifest-path scripts/desktop-native-check/Cargo.toml --target x86_64-pc-windows-msvc` | Windows 原生控件、既有截图/输入模块、交互桌面权限探测交叉检查通过 |
| `node node_modules/vitest/vitest.mjs run src/components/__tests__/AutomationControls.test.tsx src/components/__tests__/InputAddMenu.test.tsx` | 最新 25 项通过，含任务授权按钮、接管入口和原生探测状态；PermissionInlineCard 另有 7 项通过 |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| `node node_modules/vite/bin/vite.js build` | 通过；原有大 chunk 提示，不是错误 |
| `rustfmt --check --edition 2021 ...`（本项目 Rust）/ `--edition 2024 ...`（vendor 修改文件）与 `git diff --check` | 本项目及 vendor 除 commands.rs 外通过，diff 空白检查通过；commands.rs 全文件格式检查仅报原有 ReloadSkillsChecked 单行格式差异，HEAD 原文同样复现，未扩展修改该无关块 |
| `node --check scripts/validate-native-desktop-controls.mjs` 及 fixture | 通过 |
| `cargo test --offline --manifest-path scripts/desktop-native-check/Cargo.toml host_probe::actual_native_permission_and_windows -- --ignored --nocapture` | 真实执行，失败：测试可执行文件未获辅助功能授权，`authorization=required`、`permission_denied`；没有派发桌面输入 |
| 已编译并本地签名的主项目单元测试程序 `automation:: --test-threads=2`，使用独立 `ECHO_AGENT_HOME` | 授权生命周期、独立查找与面板修复后 70 通过、2 默认忽略；其后可选 AXValue 容错经独立原生工程 53 项验证 |
| 同程序 `agent_runtime::tests::injected_automation_mcp_server_is_authenticated_and_session_bound` | 1 通过 |
| 同程序 `bridge::tests::computer_permission_delegation_requires_registered_mcp_identity` | 1 通过，拒绝其他服务器、未知工具、错误 namespace 及伪造 wrapper target |
| 同程序 `automation::browser::tests::controlled_browser --ignored --test-threads=1`，独立资料目录 | 当前源码的 2 个真实 Chromium 回归用例通过（21.66 秒）；含合成页面读写、截图、跨标签下载文件；这不替代新增桌面控件的 Runtime 验收 |
| `node --test scripts/test-desktop-controls-evidence.mjs` | 8 项通过 |
| `node --test scripts/test-desktop-controls-journey-budget.mjs scripts/test-desktop-controls-evidence.mjs` | 11 项通过；新增计时回归覆盖超过两小时的人工等待、分段活动累计和时钟回退，不执行桌面动作或批准卡片 |
| `cargo test --manifest-path vendor/echo-agent-build/Cargo.toml -p echo-agent-runtime --lib automation_mode_rebuild`（隔离环境、离线尝试） | 未能执行：vendor 工作区解析需要尚未缓存的开发依赖索引（先 `lzma-rust2`，补齐后为 `ppmd-rust`）；新增两项模式重建测试不计为通过。实际应用 Runtime 重验另列 |
| `CARGO_HOME=/private/tmp/echo-control-cargo cargo build --offline --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol -j 2` | 最终应用通过；离线首次全量依赖编译 51 分钟，之后 fixture 修复构建 3分32秒 |
| 同上，应用过滤/部分枚举/窗口绑定快捷键修复后的构建 | 通过（4分46秒；更新 fixture 后确认构建 3分15秒）；实际可执行文件包含 dispatched_unverified、分页错误截断标识和新 fixture 文本 |
| 同上，验收脚本等待计时修复后的构建 | 通过（3分19秒）；未替换或重启当前等待用户恢复的专用应用 |
| 同上，AX 部分快照与能力探测修复后的构建 | 通过（4分18秒）；随后按用户要求重新启动专用合成验收 |
| 同上，AXDescription 可选标签修复后的构建 | 通过（3分39秒）；原生标签失败不再导致正文节点丢失 |
| 同上，指定配置模型的验收入口构建 | 通过（3分54秒）；随后发现恢复会话时需先点击侧栏进入该会话，已修正并增加 currentModelId 核验 |
| 同上，shortcut 字符串、游标有效期及普通文本提示修复后的构建 | 通过（3分42秒）；主项目测试程序编译 3分57秒，随后 65 项自动化及 1 项认证测试通过；未热改仍在运行的旧验收应用 |
| `readNativeReviewSession()` | 实际图形会话 unlocked/onConsole/loginDone，允许继续准备应用验收 |

初轮前端检查使用桌面工具提供的 Node 24.19；最终检查改用项目自带的 `src-tauri/resources/theia/node/bin/node`（22.23.4，满足项目 engines），系统默认 Node 20 未用于这些验证。Cargo 原有索引部分目录属于 root；离线命令首次遇到 `memo-map` 索引缺失，联网主项目构建能继续但提示无法写该缓存。尝试保留并替换 root 所属缓存叶目录时，系统返回 EACCES，未成功改动；随后使用独立临时索引离线构建。曾建立 `/private/tmp/echo-control-cargo` 临时缓存，发现会重新编译依赖后终止了该重复检查。

原生单元测试覆盖会话隔离/引用失效、同名歧义、控件消失/进程退出、窗口归属变化、禁用/只读/受保护字段、中文/多行/特殊字符、长文本完整读回、清空、树截断/分段读取、原生错误和超时传播、审批后目标变化、审批后普通引用过期时重新确认原目标、取消、桌面争用、负坐标及原有截图坐标边界、HTTP 调用方取消后原生请求仍持锁直到完成。它们证明这些约束在合成后端上的行为，不证明实际软件已经通过。

## 平台与真实场景状态

| 项目 | macOS | Windows |
| --- | --- | --- |
| 原生平台代码 | AX + AppKit 实现 | UIA8 + Win32 实现 |
| 原生模块编译与自动化 | 通过上述独立生产源码测试 | 模块交叉检查通过；无 Windows 实机测试 |
| 主项目最终编译/测试 | 最终内嵌页面构建通过；当前主项目回归 65 通过、2 默认忽略，认证测试 1 通过 | 未进行完整 Windows 主项目构建 |
| 实际 EchoAgent 应用权限 | 实际隔离 `.app` 实测辅助功能、屏幕录制和输入权限均已授予；终端测试程序权限是另一身份 | 未实机验证 |
| 真实 Runtime 新工具闭环 | Minimax 实际发现/切换窗口、读取正文控件并经批准写入/读回成功；模型入参未满足任务全文，保存闭环未完成 | 未实机验证 |
| 原生文本编辑器输入/保存/独立文件比对 | 未完成 | 未完成 |
| 文件管理器发现/选择文件 | 未完成 | 未完成 |
| 本地合成网页读写验证 | 未完成 | 未完成 |
| Electron 按钮、输入与长正文 | 未完成 | 未完成 |
| 系统文件选择框及应用收到文件 | 未完成 | 未完成 |
| 跨应用读取/输入/保存与中途暂停恢复 | 未完成 | 未完成 |
| 截图图像进入实际模型上下文 | Minimax 实际 conversation 保存工具图像后续消息，包含 PNG 图像块；不代表视觉推理或桌面任务正确完成 | 未完成 |

因此当前不能宣布整体任务完成，也不能把 Mock 测试或交叉编译报告为真实桌面通过。

## 产物和复现

自动化测试与构建日志保留在 `/private/tmp/echo-control-evidence-20261023-01a166d3/`。已保留专用验收应用中实际可见的授权卡截图；真实编辑/保存场景尚无通过产物。

只读应用资格验证（不宣称六个桌面场景通过）：

必须启用 `tauri/custom-protocol`，普通开发构建会使用 Vite 开发地址。首次运行保留在 `/private/tmp/echo-native-review-controls-VSVDLt`；该构建没有启用 custom-protocol，页面未能启动验收，不作为 Runtime 或权限通过证据。

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol -j 2
src-tauri/resources/theia/node/bin/node scripts/validate-native-desktop-controls.mjs src-tauri/target/debug/echoagent
```

运行器在 `/private/tmp/echo-native-review-controls-*` 创建私有资料目录、合成 source.txt / browser.html 和本地签名的 `EchoAgent Controls.app`。该应用通过生产 IPC 建立实际 Computer Use 任务，由真实模型调用 `computer_capabilities`、`computer_list_apps`、`computer_continue`、`automation_pause`；从会话持久化日志中的真实 MCP 类型、工具名、完整 JSON、所有分页及实际暂停结果独立判定 Runtime 接入；调用终端或有截断 JSON 均判失败。不会批准或执行桌面写操作。`driver.json`、`native-review.json`、app.log 记录实际应用 PID、二进制 SHA256、系统权限、工具完成证据及阻塞原因；`desktopAcceptance` 始终为 false。

如果系统要求权限，用户需要在系统设置中授予该确切验收 `.app`，再重跑；不能只授予终端/单元测试程序就声称安装应用具备权限。重新构建后的签名身份可能要求重新授权。六个真实桌面场景仍需在这一身份下逐项执行并保留截图、操作记录和真实输出文件。不要使用真实业务账号、消息或数据。

已知未解决的 provider 硬挂起、长文本游标和 Windows 权限限制见 [实现说明](README.md#平台限制)。

## Runtime 实测暴露的问题与修复

实际内嵌应用第一次模型验收目录为 `/private/tmp/echo-native-review-controls-VHumP0`，PID 57759，会话 `01a16755-9847-7fe3-9cc0-b8aa53f8cdec`。辅助功能/截图/输入权限在这一个实际 `.app` 身份均已授予，不能称为系统授权阻塞。模型通过 MCP 成功调用了能力、应用枚举与暂停；但应用枚举 43.5KB 被 Runtime 的默认 20000 字节限制截断到非完整 JSON，模型只数了部分应用。另有模型误走终端命令的记录，说明模式提示更新没有移除旧工具。

这一次 `native-review.json`、`driver.json` 与独立 `runtime-verification.json` 都保留失败，不能改成通过。完整原生返回虽保存到该会话的 `mcp/` 文件，但模型未完整收到；不能以事后读取该文件冒充完整工具交付。驱动当时仅等待退出 10 秒，随后 SIGTERM，故也不作为优雅退出通过。

新增分页使每个模型可见原生 JSON 不超过 12000 字节；长文本按实际 scalar 数返回 nextOffset；模式切换会重建工具配置并明确注册搜索/调用工具。新增 5 项分页风险测试覆盖逐页 JSON 上限和顺序、跨会话/单次/过期游标、刷新/写操作失效、长 Unicode/转义文本完整继续读取、分页后歧义不变。另外 2 项 macOS 原生测试验证数值/布尔读取与 UTF-16 边界不拆开 emoji。Node 证据验证 8 项通过，包含缺页/重复页、终端替代、Runtime 截断拒绝。


分页修复后的只读模型尝试保留在 `/private/tmp/echo-native-review-controls-JYhZhx`，二进制 SHA256 为 `145b07d7f3d035aebdb2a7b9da2e0e151c81f191175fa8c39b26eab0a76d77e5`。实际 system_prompt.txt 已是 Computer Use 新配置；第一次 `use_tool` 调用保持 pending，未收到 MCP 结果；同期日志包含内部模型 `reasoning_only` 重试，尚未确认其与挂起调用的因果关系。驱动在 270 秒内未收到完成报告而终止，故没有新的分页 Runtime 通过结论，也不能声称未实际出现的授权卡已经可见。

首个正常 Composer 合成任务为 `/private/tmp/echo-native-review-controls-SRePdO`，PID 82276，会话 `01a16856-d188-7dc3-9c39-f538ef85b6f9`。fixture 过早检查模式时记录错误；随后持久化 current_mode_update 已确认 computer_use，但该尝试仍保留原始错误。脚本已改为等待权威模式更新、显式说明 MCP 服务器前缀，并只观察而不代批 Runtime/桌面卡片；新一次实际记录另列。

合成桌面任务准备命令（留下实际界面，由用户选择任务授权或单次授权，脚本不代批）：

```sh
src-tauri/resources/theia/node/bin/node scripts/validate-native-desktop-controls.mjs src-tauri/target/debug/echoagent --journey
```

`--smoke` 准备五分钟活动执行预算的短流程：只验证独立纯文本文稿、中文多行写入/读回、真实保存及暂停。输出为 smoke-output.txt；它不能代替特殊字符、六个场景或 Windows 实机验收。人工等待仍不计入预算。

只在专用 `native-control-fixtures/` 中创建源数据与进度记录；真实输出 `editor-output.txt` 只能由目标文本编辑器通过系统保存对话框生成。模型报告成功后仍须独立读取输出文件，与任务中文字逐字比较。任务中途按要求调用暂停，后续恢复使用现有 UI，不通过测试脚本取消暂停。

## 用户批准后的真实日志与修复

- 应用：`/private/tmp/echo-native-review-controls-iTHVFP/EchoAgent Controls.app`；PID `82911`。
- 正常界面任务：`通用桌面控件合成验收`，会话 `01a1685f-e39d-7cc0-b214-7821cca2754c`；实际模式 computer_use。
- 这次运行的二进制 SHA256：`dcd6c4c803c8df589e2a1b6591a8fa63124f14b84d60f6d14614582724848495`（不含后续针对该日志的修复）。
- 当前实际应用权限：辅助功能 granted、screenCapture=true、inputControl=true；控件实际 probe 仍为 unknown。
- 用户在应用内批准后，实际 MCP computer_list_apps 返回首页 31 项、总计 118 项和 nextCursor；模型未取后续页。computer_open_app 实际打开 TextEdit 并返回 verified=true。
- 模型未使用 appRef 缩小范围，computer_list_windows 全局查询遇到 native_timeout；随后 computer_snapshot 缺少 windowRef 被拒绝。该日志不能证明 TextEdit 不提供 AX。
- 后续四次成功截图的 targetName 均为 EchoAgent Controls。三次 computer_click 都在输入前被 30 秒截图期限校验拒绝，没有成功点击、文本写入或保存；不能把模型对截图的文字描述当作目标窗口已激活的证明。30 分钟测试期限后暂停生效，后续截图返回“自动化已暂停”。
- 基于这些实际失败，增加 name/identifier 精确应用过滤；macOS 全局枚举优先前台和可见应用；macOS/Windows 单个 provider 错误保留有效窗口并返回不完整原因。模型策略要求目标 appRef → 真实 windowRef → 激活核验 → 控件操作/读回。
- 新增 computer_key_window：保留既有逐次确认，批准后重新验证批准窗口、恢复并核对前台/非受保护焦点，再派发已知快捷键。没有延长旧截图寿命；保存等业务结果仍需重新观察。五项新增原生测试通过，Windows 模块交叉检查和 23 项界面测试通过。
- 修正验收 fixture 对生产 agent://update 扁平事件的读取（payload.update || payload），避免进度列表漏记实际工具；原始持久化 journal 未受影响。合成输入改为真正换行并明确包含末尾换行。
- 进度：`/private/tmp/echo-native-review-controls-iTHVFP/workspaces/default/native-control-fixtures/journey-progress.json`；独立检查点为该 home 下的 `verification-checkpoint.json`。
- 真实界面截图：`/private/tmp/echo-native-review-controls-iTHVFP/workspaces/default/native-control-fixtures/pending-list-apps-approval.png`。由只读系统捕获专用 PID 的主窗口；它证明此前授权卡可见。日志提取结果为同目录 log-diagnosis.json；持久化记录为 home/sessions 下该会话的 updates.jsonl。

TextEdit 保存、Finder、本地页面、Electron、系统文件选择及跨应用暂停恢复均保持待验收；没有将当前 EchoAgent 界面操作计为这些桌面场景通过。Windows 无实机，只有原生生产模块交叉检查通过。当前整体任务未完成。

## 修复后新一轮真实检查点

专用应用 `/private/tmp/echo-native-review-controls-ApIyzo/EchoAgent Controls.app`，PID 85779，二进制 SHA256 `2ddae137f8fe331d1cbbf0a7c720b843e8a080dbd00c18dbe8eebc71e2053cbb`，会话 `01a16899-ddf6-7cd3-923e-8a7c121af306`，实际模式 computer_use，辅助功能 granted、截图/输入权限均可用。新会话已通过真实工具发现，当前正常聊天界面可见 computer_list_apps 的 Runtime 授权卡，只查询 com.apple.TextEdit。单次授权属于具体会话，旧任务的批准未转移到这次新任务；测试脚本不代批。此检查点尚不能证明控件读写/保存完成，后续以原始会话 journal 和输出文件为准。

后续实际结果（北京时间 20:23 起）：用户批准已送达，但旧 fixture 的 30 分钟墙钟期限在等待授权期间触发 automation_pause，首个 computer_list_apps 返回“自动化已暂停”，未派发任何原生动作。模型随后遇到网络响应重试并结束本轮，没有读取 TextEdit 控件。当前应保留同一个应用/会话，经工具栏「继续」恢复，再继续对话；无需另起会话或再次赋予系统权限。

针对验收脚本本身的错误，源码已改为仅累计活动执行时间：Runtime 权限、问题、文件夹信任、桌面动作确认、会话暂停及本轮结束后的人工等待均不计时；计时采用单调时钟，仍保留 30 分钟活动执行上限，达到后只暂停、不自动恢复。还会记录当前实际 automation_status 和明确的 deadlinePause 原因。该修复不会热改已经启动的进程；当前旧计时器已停止，后续恢复仍由用户操作。新增三项计时测试和内嵌应用构建全部通过，不计作真实桌面验收。用户批准后的独立检查点为该 home 的 post-approval-checkpoint.json；原 progress 中的 pending/status 在计时器停止后已过时，不能据此声称授权卡仍待批准。

北京时间 21:10 后用户恢复并发送“继续”：同一个实际 Runtime 成功按 identifier 找到 TextEdit，打开并刷新 appRef，按 appRef 取得一个未命名 AXWindow，computer_activate_window 实际返回 verified=true。模型第一次误用 ref 调 snapshot 被拒绝；改用正确 windowRef 后两次收到 native_failure: AX code -25200。没有成功读取/写入正文；后续新建快捷键还存在 key="command+n" 的错误参数。用户随后删除该会话，取消记录为 session_delete，并明确要求重新测试。旧专用进程经 PID/完整命令匹配后关闭，合成目录与日志保留。

基于上述失败，AX 错误现在带有 read(属性)/settable(属性)/count(AXChildren) 等位置；可选能力探测失败保留节点且不宣称该动作可用，非关键状态失败返回未知（启用状态失败时拒绝操作）。snapshot 保留可读节点/相邻控件并报告不完整子树，根节点/权限/进程错误仍中止。读取保护状态保持严格检查，不因元数据错误暴露受保护内容。错误快捷键在审批之前被拒绝，工具说明明确 bare key 与 modifiers 分离。这些修复的自动化测试和应用构建已通过；实际新会话结果另列，不能将修复本身计作 TextEdit 验收通过。

## 重新测试与用户指定 Minimax

新专用目录 `/private/tmp/echo-native-review-controls-5ngmNC`，会话 `01a168f3-6bd7-7061-b8a5-e9069613c973`，最初 PID 89172。真实 Runtime 已成功发现/激活 TextEdit 并读出总计 46 个控件（有分页）；原错误精确定位为正文节点 read(AXDescription) 返回 -25200。原生正文读写、保存仍未通过，editor-output.txt 尚不存在。测试进程仅经完整 PID/命令核对后关闭；before-label-restart-progress.json 和 before-label-restart-checkpoint.json 保存了更新前证据，同一会话及合成目录保留。

随后将 AXTitle/AXDescription/AXIdentifier 的此类通用失败按未知元数据返回，保留正文值/角色/引用，权限和保护状态仍严格检查。只有名称缺失时，完整树的按角色搜索可判断唯一；按名称/标识符搜索仍保留 incomplete。恢复测试时先通过正常侧栏进入既有会话，再经正常模型选择器切换，并等待会话 currentModelId 匹配；不会把首页默认模型视作已有会话已切换。脚本不批准任何动作，不恢复暂停，不自动发送既有会话的后续输入。

按用户明确要求，从 `/Users/fuyuxiang/.echo-agent/config.toml` 读取 `MiniMax-M3.1-Flash`，provider=custom、chat_completions、配置的端点主机 api.minimax.cn。仅把此模型及其提供方配置复制到 owner-only 的专用测试 config.toml，原配置未修改；不复制原聊天或业务数据。凭据未写入报告/命令输出。minimax-selection.json 仅记录模型标识和无凭据的主机。首次恢复时界面停在首页，独立核对发现已有会话仍记录 chat-qwen；该次首页选择不计为实际 Minimax 调用，启动脚本已增加会话选择与权威核验。后续实际 Minimax API 调用及结果以新的原始 journal 为准，不能只凭选择器文字宣称测试通过。

较早 driver.json 的 binarySha256 是构建源文件签名前的指纹。Minimax 重启起另存 sourceBinarySha256，并在签名后计算实际 binarySha256；旧 driver、签名二进制及更新前进度均保留，不将不同签名身份混为同一证据。

后续真正的 Minimax 任务使用专用目录 `/private/tmp/echo-native-review-controls-3xINUs`，会话 `01a16915-8ee6-7eb2-ac09-1d60803d5730`。正常 Composer 的选择、会话 currentModelId 以及首条 user_message_chunk 的 modelId 均为 MiniMax-M3.1-Flash。实际 MCP 已成功按 TextEdit identifier / appRef 发现窗口、激活并读取真实 AX 控件，用户批准 cmd+n 后出现独立「未命名2」窗口。正文 AXTextArea 保留可写能力，其 AXDescription 元数据错误明确可见，不再丢失正文节点。

截至 `minimax-native-write-checkpoint.json`：6 次成功 computer_set_value 的原生完整读回均等于各自入参，但没有一次入参等于任务指定全文。实际记录包含额外换行、字面 \\n、双反斜杠和用 emoji 替换反斜杠等差异；这些差异在 Runtime rawInput 中已存在，不能归因于 AX 写入丢字，也不能将 verified=true 当作任务完成。editor-output.txt 当时不存在，保存/独立比对及其他场景仍未通过。该检查点与原始 journal 保留在上述 home，集中证据目录另有副本；后续运行状态必须以新记录为准。

Minimax 还数次把 modifiers 传成 {"item":"cmd"} 或空字符串，且坐标数字曾以字符串传入，被严格参数校验拒绝；它也成功传入过正确数组并派发原生窗口快捷键。因此换模型确实带来了原生控件进展，但没有独立解决参数/文本准确性与整个任务完成度。新增显式 shortcut 字符串避免必须构造嵌套数组，仍经过同一审批、目标与焦点校验，不自动转换任意对象；生产提示明确普通 Unicode 文本、读回与用户目标的区别，并将截图刷新规则限定于坐标后备操作。

这次日志还暴露只读续页 98 秒时因更早的窗口发现引用达到 120 秒而失败。续页现验证保留窗口的原生身份，并使用游标自身期限；不会刷新或放宽操作引用期限。回归验证普通引用仍拒绝操作，应用退出/原生对象已释放/过期游标仍被拒绝。此修复与 shortcut 的自动化通过不等于当前应用已热更新或真实保存任务通过。

实际图像链路另有 `minimax-image-context-checkpoint.json`：同一 Minimax 会话的 chat_history.jsonl 保存了 `[Image extracted from tool result above]` 及 user image 块。独立解码保留的两张 PNG 为 915468 / 861165 字节，SHA256 分别为 ce4bb37c475896551ab1df0b24d479ebabdbed7f7ab11d3d08134694081daff7 / 08bc41e4c33dfbebbffc2c3dad1d8418cd7fb80930015fe0cd70d1d725f1d298。截图实际显示合成 TextEdit 文档及验收应用。该证据证明图像已经进入真实 Runtime 模型上下文，不能据此认定模型正确理解图片或文本已经符合要求。

## 用户要求减少审批后的代码审计

用户明确选择「改为本任务授权一次」，替代此前逐次确认要求。失败试验在 2026-10-23 22:47 左右停止，保留 before-code-audit-progress.json / checkpoint.json；没有继续让用户批准重复失败的动作。该次 journal 有 138 条已返回的桌面 MCP 调用、30 张独立桌面确认卡和 19 次 stale_reference 错误；最终目标文件不存在，验收失败。

确认并修复的代码问题：

1. Runtime 通用 MCP 权限与桌面服务授权叠加，且所有桌面副作用固定逐次询问。现在仅对当前已注册 Computer Use 服务的严格工具身份委托授权；用户在桌面卡选择单次或当前任务授权。其他 MCP、Browser Use 及明确拒绝规则不受影响。授权只存在本进程/本会话内，暂停、停止、模式切换、恢复 token 以及重启均撤销；旧审批 token 不能恢复新一轮授权。
2. 每次 find 都清空该窗口旧引用；多个独立选择器查询会使前一个结果立即不可用。现在各查询保留自己的候选与祖先，显式 snapshot 和原生写操作仍清理旧引用，目标变化仍在操作前被拒绝。重复 not_found 不累积无用引用。自动化回归重现并覆盖该问题。
3. macOS 将缺少 AXWindow 的面板控件直接判为 detached。现在仅在直接属性缺失时沿最多 32 层、有时间边界和循环检测的 AXParent 链核对原窗口；直接属性明确指向别的窗口仍拒绝。
4. macOS 假设每个子控件与主应用同 PID，导致系统服务托管的子树被误判。现在同时保留主应用与实际提供进程的 NSRunningApplication 身份，操作时两者均校验，不按 PID 临时重选新进程。仍无法取得可靠提供进程身份的节点保持不可用。
5. 某些面板容器的可选 AXValue 查询失败会导致整棵子树丢失。现在保留节点/子树并标明 observationErrors，不声明该值可读/可写；明确 computer_read 仍要求真实读取，保护属性与权限检查不放宽。

模型也确实传过错误的数组、数字类型及预转义文本；这些入参错误应与后端缺陷分别记录。新增 shortcut 字符串、明确普通文本语义、限制短流程中无变化的重复失败，减少错误恢复循环；没有延长旧截图寿命。

以上自动化与构建结果只证明对应代码约束。新的任务级授权、系统托管面板及真实输出文件结果，必须由后续正常 Runtime 短流程验证；本节不提前宣称保存或完整任务通过。

## 修改文件与用途

| 文件 | 作用 |
| --- | --- |
| `src-tauri/src/automation/accessibility/mod.rs` | 统一接口、会话引用、快照/查找/分段读、审批目标检查、工作线程与 owned 执行租约 |
| `accessibility/macos.rs` / `windows.rs` / `unsupported.rs` | AX、UIA8 与不支持平台的真实适配；原生对象生命周期、系统超时、读写和状态读取 |
| `accessibility/paging.rs` | 12000 字节有界 JSON、会话游标缓存、原始结果分页与 Unicode 文本继续读取 |
| `accessibility/tests.rs` | 合成后端风险测试及真实请求取消时的锁生命周期测试 |
| `automation/desktop_coordinator.rs` | 跨会话实体桌面队列及排队取消 |
| `automation/mod.rs` | MCP 工具注册/分发、独立确认、状态等待、生命周期清理及服务测试 |
| `automation/computer.rs` | 保留原有截图/键鼠；增加控件能力状态与 Windows 交互桌面实际探测 |
| `src-tauri/Cargo.toml` / `Cargo.lock` | 增加原生 UIA 接口依赖及 Windows 桌面 API 特性 |
| `vendor/echo-agent-build/.../echo-agent-core/src/config.rs` | Computer Use 优先控件定位/验证、截断/失效引用处理及截图后备策略 |
| `vendor/echo-agent-build/.../echo-agent-runtime/src/session/` 与 `agent/mvp_agent/acp_agent.rs` | 自动化边界重建真实工具配置、MCP 重注册、模式切换错误返回及相关测试 |
| `src/lib/automation-client.ts` / `AutomationControls.tsx` / `InputAddMenu.tsx` | 统一类型、现有入口文案和支持/授权/实际探测状态显示 |
| `src/components/__tests__/AutomationControls.test.tsx` | 原生探测 unknown/succeeded/failed 的展示验证 |
| `src-tauri/src/desktop_validation.rs` / `scripts/fixtures/native-desktop-controls-review.js` | 隔离的实际应用只读 Runtime 资格验证入口；无裸桌面执行接口 |
| `scripts/validate-native-desktop-controls.mjs` | 准备独立应用、合成资源、签名、真实 PID/二进制指纹和模型工具回传证据 |
| `scripts/lib/desktop-controls-evidence.mjs` 与验证/测试脚本 | 独立核对真实 Runtime 完整分页、会话身份和暂停结果，拒绝搜索文本、终端替代、截断和缺页 |
| `scripts/fixtures/native-desktop-controls-journey.js` | 从生产 Composer 进入合成 TextEdit 任务；保留人工逐次审批，写专用目录中的进度证据 |
| `scripts/test-desktop-controls-journey-budget.mjs` | 直接加载实际 fixture 的时钟，防止人工等待被错误计入活动执行期限 |
| `scripts/desktop-native-check/` | 直接编译生产原生代码的专用测试/Windows 交叉检查工程，隔离 Tauri WebView/链接依赖 |
| README 与 `docs/automation-platform-support.md`、本目录 | 能力入口、参数/返回、授权/暂停、已知限制与实际验收状态 |


## 参考实际控制器后的修正（2026-10-24）

详细依据见 [参考控制器对照](reference-controller-comparison.md)。确认参考脚本使用真实 AX/CGEvent，两个记录的输出文件独立复核一致；不能将其成功当成本项目 Runtime 验收通过。

新增显式 `computer_set_value.inputMethod=keyboard`，复用任务授权、原生目标凭据、执行租约和取消令牌，将准确控件聚焦、原窗口前台核验、全选替换、Unicode 输入与读回合并；默认 AX/UIA setter 不自动回退。原生路径不依赖截图帧。可选 bounds 查询失败保留节点；macOS 校验真正的 AXWindow 及图形桌面在线状态，单独提供 desktopAvailable。

参考日志明确存在 AX setter 返回 0、输入仍为空，后续 Unicode 输入成功的对照。另有系统日志证明最新试验在 00:07:44 熄屏、00:08:27 合盖休眠，00:52:13 才唤醒。对旧版能力健康误报与零显示器的处理已修正，不把全部失败归因于模型或系统授权。

旧专用进程 PID 2133 经完整命令核对后，于 01:12:36 停止，防止旧版本继续反复操作路径输入；原始会话、TextEdit 合成文稿和日志保留。`comparison-before-stop-progress.json` 与 `comparison-stop-checkpoint.json` 记录中断；该轮虽已真实写入/读回正文 17 个 Unicode 标量，smoke-output.txt 仍不存在，因此保存未通过。

本次自动化：生产原生模块 60 项通过、两项真实权限/桌面诊断默认忽略（桌面在线只读诊断另已显式运行通过）；界面 33 项通过；fixture/证据 14 项通过；TypeScript 检查及 Vite 构建通过。Windows 正确目标 x86_64-pc-windows-msvc 的生产模块检查通过；首次误选未安装的 gnu 目标失败，不算 Windows 代码失败或实机测试。本次新增功能的真实 Runtime 保存仍待验证。


后续真实 MiniMax 会话 `01a169c8-1121-7342-ae13-801ea19ba5c3` 已通过显式 keyboard 控件输入，单次输入与读回一致；真实 Return 后再读回 17 字完整正文符合短流程任务。仅 1 张首次任务授权卡、0 张通用 Runtime 权限卡。保存仍未完成，五分钟活动期限后暂停并撤销授权。checkpoint 为 `/private/tmp/echo-native-review-controls-cDR3o6/actual-keyboard-input-checkpoint.json`；细节及紧接着发现的 -25211 提供方/进程权限分类错误、异步 after 观察不一致的修正见对照文档。后续源码回归 62 项通过；未将后续源码修复视为该已运行二进制已热更新。


后续两项补丁已完成最新应用构建（3m41s），并装入 cDR3o6 原会话，PID 8265；旧签名二进制、driver/progress 已保留，当前停在既有暂停界面，MiniMax 模型及 desktopAvailable=true 均实际核对。checkpoint 为该 home 下 patched-existing-session-checkpoint.json。保存仍待用户界面恢复后复验。
