# Browser Use / Computer Use 平台与安全契约

## 支持矩阵

| 平台 | Browser Use | Computer Use | 系统前置条件 |
| --- | --- | --- | --- |
| macOS Intel | 支持 | 支持 | Chrome / Edge / Chromium；屏幕录制和辅助功能权限 |
| macOS Apple Silicon | 支持 | 支持 | 同上 |
| Windows | 支持 | 支持 | Chrome / Edge / Chromium；Per-Monitor V2 DPI |
| Linux X11 | 支持 | 支持 | Chrome / Edge / Chromium；可用的 `DISPLAY` 和 XTEST 扩展 |
| Linux Wayland | 支持 | 不启用 | Computer Use 会显示原因，需登录 Xorg/X11 会话 |

Wayland 默认不允许应用在未经桌面交互的情况下进行全局截屏和输入注入。本项目不绕过该安全边界，也不在能力检测失败时向 Agent 暴露不可执行的工具。

## 必须保持的产品行为

- 首页和任务工具栏必须使用后端实时能力检测，不可用前端平台字符串猜测。
- 应用重启后，已选择自动化模式的任务必须以“已暂停”恢复，由用户显式继续。
- 用户点击“接管”返回后，不得再有先前操作在后台继续；待确认操作同时失效。
- 网页点击、填写、选择、上传、按键和拖动，以及桌面点击、拖动、输入和按键，必须经由后端生成的用户确认；不接受模型自报风险等级。
- **电脑操作的硬安全约束**：无论任务级权限模式如何（审批 / 自动 / 始终允许），`computer_click` / `computer_drag` / `computer_type` / `computer_key` 四个工具在执行前都必须经用户独立确认。AI 在真实桌面上的副作用不可逆（购买、删除、确认对话框、退出应用），与任务级权限的"自动/始终允许"是两套独立的安全机制——前者控制分类器，后者控制真实桌面的副作用。该约束由后端 `automation::mod::ALWAYS_CONFIRM_TOOLS` 常量集中维护，未来若组织策略需要放开，由 `policy::lock_computer_always_confirm()` 控制开关。
- 确认卡不显示输入原文、URL query 或 fragment，拒绝是默认焦点。
- 密码不得经过 Agent 或文本输入工具；用户必须暂停并手动填写。
- 自动化上下文会发送给当前模型服务，界面必须持续提示。
- 受控浏览器数据按任务隔离，并提供需二次确认的清理入口。

## 网络边界

受控浏览器的 HTTP、HTTPS、iframe、子资源、脚本请求和 WebSocket 链接都必须经过任务本地代理。默认拒绝环回、私有、链路本地、多播、文档专用和保留地址。DNS 解析结果先校验再绑定到实际连接，防止页面绕过顶层 URL 检查或利用 DNS rebinding 访问内网。

用户可为当前任务显式开启内网访问，开启前必须再次确认；撤销时立即断开旧连接并离开已打开的内网页面。

## 验收基线

- 前端：TypeScript 检查、全量 Vitest、生产构建。
- Rust：`cargo fmt --check`、`cargo clippy --lib -- -D warnings`、自动化模块单元测试。
- Browser Use：在安装 Chromium 系浏览器的桌面环境显式执行 ignored smoke test，覆盖启动、快照脱敏、密码拒绝、普通输入、点击、截图、标签页和数据清理。
- 平台：macOS Intel 原生检查与测试，Apple Silicon 交叉编译，Windows 原生 CI 检查与测试，Linux X11 在 Ubuntu CI 编译与测试。
