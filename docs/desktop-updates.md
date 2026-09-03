# EchoAgent 桌面版本升级

EchoAgent 使用 Tauri 2 updater 的静态 JSON 协议。客户端从
`https://10.132.19.82:8787/desktop-updates/stable/{{target}}-{{arch}}.json`
读取当前平台版本，
按 SemVer 判断是否升级，然后校验 minisign 签名并安装。

## 安全边界

- 更新服务器只保存公开的安装包、`.sig` 和分平台 JSON 清单。
- 签名私钥绝不上传到发布服务器，也不提交到 Git。它只存在受保护的构建机或 CI secret 中。
- 客户端内置组织 CA，仅增加该 CA 为可信根；没有关闭 TLS 或主机名校验。
- 签名公钥编译进客户端。遗失私钥后，现有客户端无法再接收新更新，必须对私钥做加密离线备份。

## 构建

Tauri 生成升级包时必须提供私钥：

```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.config/echoagent/updater/echoagent.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
bash scripts/build.sh --version 0.3.10
```

Windows PowerShell：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME\.config\echoagent\updater\echoagent.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Version 0.3.10
```

产物：

- Windows x64: `src-tauri/target/release/bundle/nsis/*-setup.exe` 及同名 `.sig`。
- macOS: `src-tauri/target/release/bundle/macos/*.app.tar.gz` 及同名 `.sig`。
- 用户安装用的 `.dmg` 不是 updater 下载包。

`package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的版本必须一致。

## 发布

必须先完成所有平台构建和测试。然后逐个发布同一版本的平台产物：

```bash
bash scripts/publish-update.sh \
  --version 0.3.10 \
  --target darwin-aarch64 \
  --artifact src-tauri/target/release/bundle/macos/EchoAgent.app.tar.gz \
  --notes-file release-notes.md
```

Windows 产物可在 Git Bash/WSL 下使用同一脚本发布。服务端会：

1. 验证 SemVer、目标平台、文件扩展名和 `.sig` 格式。
2. 拒绝覆盖更高版本。
3. 先原子写入版本目录的安装包、签名和 SHA-256。
4. 最后原子替换对应的平台清单，例如 `darwin-aarch64.json`。各平台可独立发布，不会让尚未准备好的平台看到错误更新。

发布后验收：

```bash
curl --cacert src-tauri/certs/echo-agent-server-ca.pem \
  https://10.132.19.82:8787/desktop-updates/stable/darwin-aarch64.json
```

使用一台安装了旧版本的真实 Windows/macOS 客户端分别验证：启动自动检查、
帮助页手动检查、断网启动、签名失败拒绝安装、下载进度、安装与重启。
