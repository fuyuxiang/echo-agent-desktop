# Windows 构建说明

EchoAgent 的 Rust 后端必须使用 MSVC 工具链构建。请先安装 Visual Studio 2022 Build Tools 并勾选 **使用 C++ 的桌面开发** 工作负载以及较新版本的 Windows SDK，再通过 `dev.bat` 或 *x64 Native Tools Command Prompt for VS 2022* 启动开发。

下文记录 Windows 平台实测中常踩到的坑，按首次构建到打包的顺序排列。

## 1. 工具链初始化

```powershell
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
pnpm install --frozen-lockfile
.\dev.bat
```

`vendor/grok-build/` 已作为普通源码提交到主仓库，并直接包含 Windows 兼容性修改和 EchoAgent 协议命名空间迁移。`scripts/setup.ps1` 只检查源码快照是否完整，不会访问或修改其他 Git 仓库。

### 1a. MSVC 工具链识别 ⚠️ 最容易漏

`x86_64-pc-windows-msvc` 目标**必须有 MSVC `link.exe`**。只安装 Visual Studio IDE 不够 —— 必须勾选「使用 C++ 的桌面开发」工作负载。

症状：在 Git Bash 中编译到链接阶段会报 `link: extra operand '...rcgu.o'` 或 `Try 'link --help'`，这是 Git Bash 自带的 GNU coreutils `/usr/bin/link` 抢在了 MSVC link 前面。

验证方法：在「x64 Native Tools Command Prompt for VS 2022」里执行 `where link.exe`，应指向 `...\VC\Tools\MSVC\<ver>\bin\Hostx64\x64\link.exe`，而不是 Git Bash 路径。

若缺失可用 winget 补装（约 3–6 GB 下载）：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --silent `
  --accept-package-agreements --accept-source-agreements `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

### 1b. Rust 工具链

`rustup` 装好后默认可能停在旧版本，必须 update 才能满足 `rust-version = 1.92`。

```bash
rustup default stable-x86_64-pc-windows-msvc
rustup update stable
rustc --version   # 确认 ≥ 1.92
```

## 2. protoc

上游 Runtime 自带的 `bin/protoc` 是 DotSlash 脚本，**没有 windows 平台条目**，直接运行会失败。需安装系统级 `protoc`。

```powershell
# 方案 1：GitHub 可达时
winget install --id Google.Protobuf --accept-package-agreements --accept-source-agreements

# 方案 2：GitHub 不可达时，使用与上游 DotSlash 锁定的 29.3 版本，走 ghproxy 镜像
# https://ghproxy.net/https://github.com/protocolbuffers/protobuf/releases/download/v29.3/protoc-29.3-win64.zip
# 解压到 C:\Tools\protoc\
```

`PROTOC` 环境变量已在 `src-tauri/.cargo/config.toml` 的 `[env]` 段设好，默认指向 `C:\Tools\protoc\bin\protoc.exe`；若安装到其他位置请相应修改。

> 上游 patch 会让 `descriptor_set_out=NUL` 在 `protoc` 的 CWD 下生成一个真实名为 `NUL` 的文件，是无害垃圾。用 `cmd del` 或 `git clean` 无法删除，需要 Node 构造 `\\?\` 前缀的绝对路径：`fs.unlinkSync('\\\\?\\C:\\path\\to\\NUL')`。

## 3. 网络镜像（国内机器常需）

若 `github.com` 或 `crates.io` 连接超时，分别配置两套镜像。

**crates.io** → 在 `~/.cargo/config.toml` 配置 rsproxy（字节维护）：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[net]
git-fetch-with-cli = true
```

**github.com git 克隆** → 在 `~/.gitconfig` 配置 insteadOf。注意：cargo 的 `[url]` 表在 `git-fetch-with-cli=true` 时不生效，必须配系统 git：

```bash
git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/"
```

上游 Runtime 全树只有一个 GitHub git 依赖（`helix-editor/nucleo`），其余依赖都在 crates.io。

## 4. 链接器 OOM（LNK1102）

32 GB RAM + 默认并行度跑 `cargo test` 或 release 链接时，commit limit 会被耗尽，症状是各种假错误：

- `E0786` 元数据无效
- `E0462` staticlib-rlim 混杂
- `LNK1102` 内存不足

解法：限制并行度。

```powershell
cargo test -j 2
# 或
$env:CARGO_BUILD_JOBS = 2
pnpm tauri build
```

## 5. WiX / NSIS 下载被墙

Release 构建会触发上游 Runtime 的 `build.rs` 下载 ripgrep，并触发 Tauri 打包流水线下载 WiX 和 NSIS 工具链。

- **WiX**：MSI 打包要下 `wix314-binaries.zip`，GitHub 直连可能超时或 10054。走 ghproxy 断点续传下到 `%LOCALAPPDATA%\tauri\WixTools3.14.1\`（解压即用）。注意 Tauri 按版本号找目录，旧的无版本号 `WixTools` 缓存不会被复用。
- **NSIS**：不额外下载，缓存在 `%LOCALAPPDATA%\tauri\NSIS`，复用即可。
- **ripgrep**：若不想触发下载，可设置 `GROK_SHELL_BUNDLE_RG_PATH` 指向已安装的 `rg.exe`（如 ZCode 自带）。

## 6. 打包

```powershell
pnpm dist:win
```

产物在 `src-tauri/target/release/bundle/`，包含 `.msi`（WiX）和 `.exe`（NSIS）安装包。当前安装包未进行代码签名或公证，请仅在可信 Release 中分发。
