# 桌面任务的调用与耗时

性能以真实 Runtime 会话为准。计时包含模型思考、工具调用、暂停后的 5 秒静默检查和最终核验；统计包含失败调用。用同一台电脑、同一 MiniMax 模型和同样的输入、保存、暂停、继续条件比较，单次结果不代表稳定分位数。

## 基线

`GLOuNl`：520.273 秒，70 次返回的电脑工具调用，其中 4 次失败；19 次应用/窗口发现，11 次截图。原始日志显示重复发现和观察、暂停后的引用重建、错误的副本快捷键，以及目录候选项的命中误判。主流程虽完成，工具往返占据了大部分时间。

## 当前严格通过样本

`nzpXSF`：输入、暂停继续和保存 **48.653 秒 / 9 次电脑调用**；正文读回 19.998 秒，继续后至完成 22.969 秒，失败 0、截图 0，保存面板只打开一次。相对于上一轮 `Ns82Mz` 的 116.978 秒 / 28 次调用，耗时减少 58.4%、调用减少 67.9%。

Safari 独立任务从 **362.252 秒 / 40 次调用** 降至 **82.821 秒 / 15 次调用**，耗时减少 77.1%、调用减少 62.5%；截图 7→1，续页 5→0，独立观察 9→0。三次系统文件面板准备全部成功；两项任务普通确认卡均为 0，实际文件和页面读入结果均独立核验通过。

保留纠正成本：Safari 有一次窗口上下文变化后的过期引用拒绝和一次末尾字符读回不一致后的输入重试。中间轮 `W8j6hB` Safari 182.239 秒，但主任务 214.555 秒退步；冷启动及模型反复判断、数字/组合键传参错误均另记，未用最终样本覆盖。结果为单轮样本，不是稳定分位数。详见 [验证记录](validation.md)、[两阶段机器统计](latest-performance-comparison.json) 和 [源码及构建指纹](latest-performance-provenance.json)。

## 通用执行改动

- `computer_context` 合并应用匹配、窗口发现、当前控件观察和实际菜单命令。应用匹配支持系统名称、标识及安装包/可执行文件别名，不维护应用名称翻译表。
- `computer_file_dialog` 将已打开的 macOS 标准 Open/Save 面板的路径导航、读回及文件名准备合并为一次可取消调用；不打开/重开面板，准备后模型按返回控件提交并验证。不按宿主应用名称分支。
- 原生动作附带更新后的 `state`，供下一步直接使用。键盘操作同时刷新菜单命令；文字输入保留实际读回结果，无需再为同一内容查找、读取或截图。
- 菜单快捷键来自应用当前的原生菜单，区分保存、副本及格式切换等真实命令。没有针对某个编辑器硬编码保存流程。
- 应用和窗口使用经本机身份重新验证的会话引用。暂停保留这些只读身份，撤销执行令牌并清理控件引用、动作凭证与分页，继续时一条上下文查询即可重新定位。应用退出、窗口消失、重启、切换任务及会话隔离仍使相关身份不可用。
- macOS 窗口发现合并 AXWindows、AXFocusedWindow 和 AXMainWindow；激活请求后读取系统 AXFocusedApplication 的真实 PID 并核对原窗口，避免把缓存属性或请求返回当成前台身份。AppKit 的动态属性有运行循环刷新语义，参见 [Apple 文档](https://developer.apple.com/documentation/appkit/nsrunningapplication)。
- 短控件引用在新观察确认同一对象、未变内容及原窗口/文档后沿用；改变或移除目标仍失效。原生命中检查支持经过验证的行/单元格与其子控件关系，减少列表中的假遮挡；仍要求同一窗口身份、有效目标、非保护内容及取消检查。截图仍是实际缺少控件或需要视觉判断时的后备。
- 观察只对瞬时提供方超时重读一次，取消后停止；不重放物理操作。严格解析提供方有限层级的 `{item: [...]}` / 单值封装，继续校验键名和修饰键。公共数字入口接受已观察到的数字字符串，保留有限数字及整数范围检查，未处理文本、引用和布尔授权字段。用户文字优先采用经焦点核验的键盘输入，以触发应用反应；原生值读回仅证明该属性已改变。
- 上下文把输入框、可操作目标和内容置于前面，省略空结构容器并标记覆盖；完整结构仍可用 snapshot。控件状态省略重复的默认布尔值并声明统一默认值，保留空文本、禁用、受保护与截断信息，减少复杂应用的分页。父链缺失时，按同一原生对象身份在宿主实时控件树核验归属，查找有深度、数量和时间边界。
- 控件、窗口与菜单返回均有数量/字节边界，并显式标记截断；目录导航要验证新状态，未知结果不盲目重放。

## 重现与独立核验

先构建内嵌页面的独立应用，再运行隔离验收。模型资源为用户已有配置的私有副本，不能放进仓库或验证日志。

```sh
CARGO_HOME=/private/tmp/echo-control-cargo cargo build --offline --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol -j 2
ECHO_DESKTOP_REVIEW_CONTROLS_MODEL_RESOURCE=<owner-only-model-resource> src-tauri/resources/theia/node/bin/node scripts/validate-native-desktop-controls.mjs src-tauri/target/debug/echoagent --universal-flow
src-tauri/resources/theia/node/bin/node scripts/verify-native-desktop-task-flow.mjs <acceptance-home>
src-tauri/resources/theia/node/bin/node scripts/compare-desktop-task-performance.mjs /private/tmp/echo-native-review-controls-Ns82Mz <acceptance-home>
```

`--universal-flow` 保留原三条消息的严格验收，并追加一个独立 Safari 任务：原生操作新标签页、合成页面输入、点击及系统文件选择。页面只有在正文和所选文件的真实字节都正确时才显示唯一成功标记；核验器要求 Safari 的原生状态实际读到该标记。验收脚本只准备合成页面并通过正常输入框提交用户消息，不代做目标操作，不生成目标文稿，不替用户恢复或授权。
