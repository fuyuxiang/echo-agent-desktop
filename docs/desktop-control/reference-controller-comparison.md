# 与已可运行桌面控制脚本的对照（2026-10-24）

参考源：用户提供的 `/Users/fuyuxiang/Documents/ChatGPT/New project/desktop_ax.py`、`benchmark_driver.py` 与 `desktop_capability_evidence/`。仅作为实现与实测证据读取，未运行其中的写操作或自动审批流程，未修改参考目录。

## 参考实现实际做了什么

Python ctypes 直接调用 macOS AX 与 CoreGraphics。先按应用 bundle identifier 找到实际进程；每次调用重新读取控件树，通过角色、名称、identifier 或观察到的路径定位目标。副作用前激活应用；Unicode 输入前设置 AXFocused，并再次确认焦点。替换操作为全选、删除、CGEvent Unicode 输入。控制器会重新读 AXValue，核对完整 prompt 后才点发送。

文件选择器使用 Cmd+Shift+G、聚焦 PathTextField、Unicode 替换、观察到的项目双击及打开按钮；对列视图只遍历当前文件夹列，避免祖先列耗尽树预算。输入、点击与发送后有短暂等待和新快照。两款应用 bundle、入口名称、部分窗口号与任务步骤有专门适配；这些适配提高已知流程的可靠性，但实际输入和点击确为系统桌面事件。

`smoke_summary.json` 记录的两份真实输出文件仍存在，独立解析均与记录一致（marker=SMOKE_ATTACHMENT_20261023，sum=12）。这证明参考脚本能控制这两款应用完成对应冒烟流程；不据此扩展为任意应用、任意任务或 Windows 已通过。

## 找到的具体差异

| 证据/问题 | 影响 | 本次处理 |
| --- | --- | --- |
| 参考 `010231_554564_EchoAgent_set.json` 中 AXValue 设置 error=0，但 AXTextArea 的值仍为空；随后 `010317_946864_EchoAgent_type.json` focus_error=0，Unicode 输入后值长 14 | 原生 setter 返回成功不等于应用输入生效 | `computer_set_value` 保留原生 value 默认方式，新增显式 inputMethod=keyboard，原窗口激活、目标控件焦点核对、全选替换、Unicode 分块及实际读回组成一次受授权操作；不自动重放/切换方法 |
| 旧实现依赖多次快捷键/截图输入调用 | 模型思考、前台切换及 30 秒截图期限放大失败率 | 已观察的文本控件可直接走键盘输入方式，无须截图或延长截图期限；每块输入前核验原窗口和原控件焦点 |
| AXPosition/AXSize 等可选观察失败可能丢失节点 | 仍能输入的控件无法被定位 | 保留节点、bounds 未知及 observationErrors；权限、保护状态和真实对象身份检查保持严格 |
| 休眠时 AXWindows 曾返回 role=AXApplication，却被标成 kind=window | 模型继续操作无效“窗口” | 校验 AX 对象类型及 AXWindow 角色；异常保留为不完整枚举问题 |
| TCC 授权仍为 granted，但图形桌面已离线 | capabilities 显示健康，模型反复尝试截图/激活 | 单独报告 desktopAvailable；核对 console/login/lock 和活动显示器，离线时停止原生调用并清空引用、分页和审批凭据 |
| 原先 Runtime 通用审批与每步桌面审批叠加 | 远慢于手动操作 | 前轮已按用户明确选择改为本任务授权一次；本次输入路径使用同一授权与执行租约，不增加审批层 |

## 上一轮失败与休眠证据

系统电源日志（只读）确认：2026-10-24 00:07:44 显示器关闭；00:08:27 Clamshell Sleep；随后多次 DarkWake；00:52:13 LidOpen/UserActivity 唤醒。最新测试中零显示器、AXApplication 假窗口和激活失败落在该时段。当前升级权限后的只读探测确认 console/login 为 true、screenLocked=false、主显示器非零；普通受限命令中的空 CGSession 字典不能据此断言用户桌面锁定。

专用会话：`01a16983-078c-7ab1-8e4e-2ca9f9cbef1d`，目录 `/private/tmp/echo-native-review-controls-fJReYS`。首次任务授权后，确有连续取消旧保存面板、新建窗口、派发纯文本快捷键，期间没有重复桌面审批。休眠/活动期限暂停会撤销任务授权。唤醒并由用户恢复后，真实 AXTextArea 已成功写入并完整读回 `桌面控件验收\n中文输入与读回成功\n`（17 个 Unicode 标量）；保存对话框路径反复回退，尚无 smoke-output.txt。已有写入成功不等于保存完成。

这次参考文件指纹、实际原始 journal 路径及检查点保存在 `/private/tmp/echo-control-evidence-20261023-01a166d3/reference-controller-comparison.json`，未将参考脚本的成功移记为产品验收成功。

## 仍需真实验证

本次新增键盘输入、休眠恢复和文件选择器路径提交必须在新应用中经正常 Runtime 验证。自动化测试的通过不能代替真实 TextEdit 保存、Finder、本地网页、Electron、系统文件选择和跨应用暂停恢复。Windows 仍无实机，仅检查相同生产模块能否编译。更深控件树与文件选择器列视图的有界搜索仍有优化空间；不能把缺少候选一概解释成目标应用不支持 AX。


## 本轮验证记录

- 生产原生模块：60 项通过，2 项真实环境探测默认忽略；另显式运行真实桌面在线只读探测 1 项通过，没有桌面输入。
- 相关界面：33 项通过；fixture 与证据：14 项通过；TypeScript/Vite 通过。
- Windows：相同生产模块 x86_64-pc-windows-msvc 检查通过，无实机验收。
- 桌面输入与保存：新键盘方式尚未完成真实 Runtime 验证，不能用以上测试代替。


## 新键盘路径的真实 Runtime 结果与后续修复

专用目录 `/private/tmp/echo-native-review-controls-cDR3o6`、会话 `01a169c8-1121-7342-ae13-801ea19ba5c3`。正常 Composer 及会话 currentModelId 均为 `MiniMax-M3.1-Flash`，实际 `computer_set_value(inputMethod=keyboard)` 已写入 16 字中文多行正文并完整读回等于该调用入参；随后真实 Return 补入末尾换行，第二次 computer_read 完整 17 字与任务全文一致。输入有真正 LF，未把 JSON 转义误判为字面反斜杠。仅首次 computer_open_app 桌面卡授权一次，通用 Runtime 权限卡为 0。具体凭据、调用号、签名指纹和读回见 actual-keyboard-input-checkpoint.json（该 home 与集中证据目录各一份）。

保存未通过：模型转向全局窗口枚举时，某个提供进程返回 -25211；原代码把该错误一概当成 EchoAgent 失去辅助功能授权，因而丢弃其他可用窗口。同一时间按 TextEdit appRef 的枚举成功、能力预检仍为 granted，证明这次不能直接要求用户重新授权。修复后会重新检查本进程 AXIsProcessTrusted：只有进程确实失去信任才返回 permission_denied；仍可信时返回该提供方 accessibility_unavailable，全局枚举保留其余窗口和不完整问题。

另修复键盘派发异步导致的响应矛盾：最初 after 观察可能早于输入事件交付，虽后续精确读回成功，返回的 after 仍为空。现改为在读回之后重新观察再返回。新增回归模拟延迟交付，断言 verified 与 after 的一致性。

这两项后续修复后的生产原生回归为 62 项通过、2 项实机诊断默认忽略，Windows 生产模块另检查。此前运行到五分钟活动期限后已按机制暂停并撤销任务授权，smoke-output.txt 不存在；不把正文成功扩展为保存或全场景通过，也不通过脚本恢复暂停。


最新补丁完整内嵌应用构建通过（3m41s），已在原目录、同一会话恢复界面，PID 8265；source SHA256 为 174d94c414039172c15b099bf8dbbd421838444c1fbd7a73f72ff1d69883d618，签名后 SHA256 为 fb586a2b29d2213e45c1e30143b599a972dfca080e0a77228c041ef53ac550b6。旧签名二进制另存 previous-signed-binary-*，更新前 driver/progress 已备份。模型选择权威核对仍为 MiniMax-M3.1-Flash；当前 paused=true、computerAuthorized=false、desktopAvailable=true，无脚本恢复或批准。后续保存复验等待用户经现有界面继续。


## 恢复入口与系统嵌套面板焦点（2026-10-24 后续）

用户发送“继续”后，日志确实记录了该消息，但自动化后端仍 paused=true；普通聊天的“恢复”“恢复并继续”原先只清理聊天 store，没有同步调用 automation_resume。现仅在用户明确点击这些按钮时，同步恢复对应的自动化后端，再发送继续消息；后端恢复失败时不发送，消息未被接纳时重新暂停。没有在收到任意消息、加载会话或模型调用时自动恢复，也没有自动授予任务权限。电脑工具栏的显式继续按钮不再被模型 streaming 状态禁用。

用户随后实际恢复了电脑工具栏并授权，原生 PathTextField 输入到达后端，却因 focus_changed 在发送文本前被拒。只读系统诊断确认 TextEdit 的真实 AXFocusedWindow 为 AXSheet，父级链是 AXSheet → AXSheet → 原 AXWindow，而非失焦到其他应用。旧 activate/key/text 校验要求 AXFocusedWindow 与主窗口 CFEqual，这会错误拒绝合法保存、前往文件夹的嵌套面板。

现统一检查主窗口或其 AXSheet：只接受原窗口本身，或通过真实 AXWindow/有界父级链验证归属于原窗口的 AXSheet；独立其他 AXWindow/AXApplication 不可被接受。前台应用、目标控件原生身份和实际键盘焦点、保护字段、任务授权与取消检查均继续生效。窗口已拥有该面板焦点时不再重复 raise 主窗口破坏现场。

对应生产模块回归 63 项通过、2 项真实环境诊断默认忽略；包含 ChatView 恢复与失败回滚的四个界面文件共 66 项通过。当前旧进程的这轮仍因五分钟活动期限暂停，文件尚未生成；新增面板焦点代码须在后续构建中实际验证，不能把单元测试记作保存成功。
