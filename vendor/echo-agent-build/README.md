# EchoAgent Agent Runtime

This directory contains the Rust agent runtime embedded in
[EchoAgent Desktop](../../README.en.md). It is maintained as source inside the
main repository so desktop releases can build reproducibly from one pinned
tree.

The runtime provides the execution engine behind EchoAgent sessions:

- multi-turn agent orchestration, context compaction, and session persistence;
- tool discovery and execution for files, terminals, search, MCP, and skills;
- permission gates, sandbox integration, hooks, and plugin loading;
- subagents, worktrees, checkpoints, background tasks, and status events;
- ACP, headless, terminal, and workspace service adapters;
- provider-neutral sampling used by EchoAgent Desktop's BYOK configuration.

EchoAgent Desktop supplies provider endpoints and credentials at runtime. A
hosted EchoAgent account is not required for the desktop integration.

## Integration contract

| Surface | EchoAgent value |
| --- | --- |
| Runtime source root | `vendor/echo-agent-build/` |
| Crate/package prefix | `echo-agent-` |
| Rust module prefix | `echo_agent_` |
| Protocol namespace | `echo.agent` |
| Runtime home variable | `ECHO_AGENT_HOME` |
| Default runtime home | `~/.echo-agent` |
| Bundled ripgrep variables | `ECHO_AGENT_TOOLS_BUNDLE_RG_PATH`, `ECHO_AGENT_RUNTIME_BUNDLE_RG_PATH` |

Legacy home and theme values are read only by narrowly scoped compatibility
paths so existing local data can be imported safely.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `crates/codegen/echo-agent-runtime` | Session lifecycle, sampling, persistence, auth adapters, and runtime APIs |
| `crates/codegen/echo-agent-core` | Agent composition, prompts, plugins, and tool wiring |
| `crates/codegen/echo-agent-tools` | Built-in tool implementations and schemas |
| `crates/codegen/echo-agent-workspace` | Filesystem, process, VCS, worktree, and checkpoint services |
| `crates/codegen/echo-agent-mcp` | MCP client and server integration |
| `crates/codegen/echo-agent-pager*` | Terminal UI, rendering, and PTY validation harnesses |
| `crates/common` | Shared protocol and runtime primitives |
| `crates/build` | Build-time helpers, including protobuf generation |
| `prod/mc/echo-agent-chat-proxy-types` | Shared chat transport types |
| `third_party` | In-tree third-party components covered by their original notices |

The root workspace manifest is generated from the vendored snapshot. Keep
package-level changes in the relevant crate manifest and update the root
manifest only when workspace membership or shared dependencies change.

## Validation

Run these commands from the EchoAgent Desktop repository root:

```sh
node scripts/verify-vendored-runtime.mjs

ECHO_AGENT_TOOLS_BUNDLE_RG_PATH=/usr/local/bin/rg \
ECHO_AGENT_RUNTIME_BUNDLE_RG_PATH=/usr/local/bin/rg \
cargo check --locked \
  --manifest-path vendor/echo-agent-build/Cargo.toml \
  --workspace --all-targets

cargo clippy --locked \
  --manifest-path src-tauri/Cargo.toml \
  --lib -- -D warnings
```

Set the two ripgrep paths to the appropriate executable on the build host.
The desktop build scripts populate the same variables when packaging the app.

## Provenance and licensing

The snapshot's upstream revision and integration metadata are recorded in
[`ECHOAGENT_VENDOR.json`](ECHOAGENT_VENDOR.json). EchoAgent-specific maintenance
notes live in [`ECHOAGENT_VENDOR.md`](ECHOAGENT_VENDOR.md).

The upstream source remains available under the Apache License 2.0. See
[`LICENSE`](LICENSE), [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES), and
[`third_party/NOTICE`](third_party/NOTICE) for attribution and bundled component
licenses.

Security reports should follow [`SECURITY.md`](SECURITY.md).
