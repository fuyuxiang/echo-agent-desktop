# EchoAgent 桌面版发布流程

平台构建和 updater 签名是两个独立阶段。项目默认关闭 Tauri 构建阶段的 updater 产物生成；macOS/Windows 编译机只生成标准命名的安装包。受控发布机统一生成 updater 包、使用唯一私钥签名并发布。updater 私钥不得放进仓库，也不需要分发给平台编译机。

## 1. 同步版本并构建

版本来自以下四个文件，构建脚本会同时更新并校验它们：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

先在一台机器上更新版本并提交，其他编译机拉取同一提交。也可以由第一台编译机执行：

```bash
bash scripts/build.sh --version 0.3.11
```

随后正常构建：

```bash
# Apple Silicon 或 Intel Mac
bash scripts/build.sh

# Windows x86_64
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

标准安装包名称固定为：

- `EchoAgent-v0.3.11-windows-x86_64-setup.exe`
- `EchoAgent-v0.3.11-darwin-aarch64.dmg`
- `EchoAgent-v0.3.11-darwin-x86_64.dmg`

生产构建默认要求 macOS Developer ID/Gatekeeper 或 Windows Authenticode 验证通过。`--allow-unsigned-platform` / `-AllowUnsignedPlatform` 只能用于开发检查，这类包不能进入正式发布。

## 2. 在发布机生成 updater 产物

发布机必须是 macOS，并安装 `osslsigncode`，以便独立验证 Windows Authenticode。私钥保存在仓库之外，例如：

```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.config/echoagent/updater/echoagent.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='密钥密码（无密码时留空）'
```

将三台平台编译机的安装包放到发布机后执行：

```bash
bash scripts/prepare-update-artifacts.sh \
  --windows-exe /path/to/EchoAgent-v0.3.11-windows-x86_64-setup.exe \
  --mac-arm64-dmg /path/to/EchoAgent-v0.3.11-darwin-aarch64.dmg \
  --mac-x64-dmg /path/to/EchoAgent-v0.3.11-darwin-x86_64.dmg
```

脚本会验证三包版本、目标架构、bundle ID、平台签名以及项目版本；macOS `.app` 会打包成 Tauri 需要的 `.app.tar.gz`。所有 updater 文件在采用标准名称之后签名，并自动确认签名密钥 ID 与应用内置公钥一致。结果位于 `release/v<版本>/`。

私钥至少应有一份离线加密备份。丢失私钥后，已经安装且只信任旧公钥的客户端无法验证新密钥签发的更新。

## 3. 一次发布三个平台

```bash
bash scripts/publish-all-updates.sh \
  --artifacts-dir release/v0.3.11 \
  --notes-file /path/to/release-notes.txt
```

发布脚本读取 `artifacts.json`，先统一检查三个目标的文件名、SHA-256、updater 签名元数据和平台签名状态，再逐平台调用服务器发布器。服务器还会再次校验“版本—目标—文件名”关系并拒绝版本回退。网络中断时可原命令安全重跑，已经成功的平台会用同版本的相同产物重新确认，尚未完成的平台继续发布。

只做发布前检查、不上传时追加 `--dry-run`。

已安装版本必须低于服务器版本才会显示更新；`0.3.11` 客户端不会把同一个 `0.3.11` 当作更新。
