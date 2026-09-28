# Browser Use / Computer Use 平台与安全边界

首页按后端实时检测展示能力。Browser Use 需要安装 Chrome、Edge 或 Chromium；Computer Use 还取决于系统截屏与输入权限。Linux 自动化底层可用不代表已有 Linux 桌面安装包。

| 平台 | Browser Use | Computer Use 条件 |
| --- | --- | --- |
| macOS Intel / Apple Silicon | 检测到 Chromium 系浏览器后可用 | EchoAgent 获得「屏幕录制」和「辅助功能」权限 |
| Windows | 检测到 Chromium 系浏览器后可用 | 桌面截图与输入能力检测通过 |
| Linux X11 | 检测到 Chromium 系浏览器后可用 | X11 会话提供 XTEST 扩展 |
| Linux Wayland | 检测到 Chromium 系浏览器后可用 | 不启用全局截屏和输入注入；需切换 X11 会话 |

## 任务控制与确认

- 每个任务有独立的浏览器 Profile 和下载目录。删除任务时清理对应数据；自动化任务在应用重启后以暂停状态恢复，需要用户主动继续。
- 浏览器点击、填写、选择、上传、按键和拖动，以及电脑点击、拖动、输入和按键，都会在执行前由后端请求独立确认。`computer_click`、`computer_drag`、`computer_type`、`computer_key` 即使任务设置为「始终允许」也不能跳过确认。确认卡默认聚焦拒绝，不展示输入原文或 URL 的 query/fragment。
- 暂停或手动接管会取消正在进行和待确认的操作。电脑操作依赖当前截图产生的坐标帧，画面变化后旧帧失效。浏览器密码字段不会进入 DOM 快照，也不接受工具输入；请暂停后自行登录。
- 网页内容、浏览器截图和电脑截图会作为任务上下文发给当前选用的模型服务。

## Browser Use 网络范围

受控浏览器的顶层导航、子资源及 WebSocket 经任务本地代理。默认只访问公网 HTTP/HTTPS，拒绝环回、私网、链路本地和保留地址，并校验 DNS 解析后的实际目标。用户可以为当前任务显式开启内网访问；撤销时会断开旧连接并离开已打开的内网页面。文件上传限于当前授权工作区的普通文件，披露前还需单独确认。

实现见 [`automation/mod.rs`](../src-tauri/src/automation/mod.rs)、[`network_proxy.rs`](../src-tauri/src/automation/network_proxy.rs)、[`browser.rs`](../src-tauri/src/automation/browser.rs) 和 [`computer.rs`](../src-tauri/src/automation/computer.rs)。
