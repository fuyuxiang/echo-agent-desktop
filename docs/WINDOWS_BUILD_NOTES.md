# Windows build notes

EchoAgent's Rust backend must be built with the MSVC toolchain. Install Visual
Studio 2022 Build Tools with the **Desktop development with C++** workload and
a recent Windows SDK, then launch development through `dev.bat` or from an
x64 Native Tools terminal.

The embedded grok crates also require a native `protoc` executable. Install
Protocol Buffers, ensure `protoc` is on `PATH`, and set `PROTOC` when it is not
discoverable automatically:

```powershell
setx PROTOC "C:\path\to\protoc.exe"
```

After cloning, initialize the pinned grok-build submodule and apply the
repository-maintained compatibility patches:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Build installers with:

```powershell
pnpm install --frozen-lockfile
pnpm dist:win
```

Do not commit machine-specific Cargo configuration. If a local proxy or mirror
is required, configure it in the user-level Cargo or Git configuration.
