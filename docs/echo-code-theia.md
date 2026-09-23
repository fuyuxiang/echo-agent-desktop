# Echo Code IDE integration

`更多 → 代码开发` embeds the browser build of Eclipse Theia 1.74.0 from
`vendor/theia-platform/`. Theia owns the file explorer, Monaco editor, search,
Git, terminal, and mini browser. The surrounding React pane keeps EchoAgent's
existing task lifecycle, Agent Runtime session, change set, verification, and
delivery gates.

## Build and distribution

- Use Node.js 22 or 24+ on the target platform.
- `pnpm ide:build` compiles the vendored source and creates a production Theia
  browser and backend bundle.
- `pnpm ide:stage` copies runtime files into `src-tauri/resources/theia/`,
  installs production dependencies from `scripts/theia-runtime-package-lock.json`,
  and copies the current platform's Node.js executable and license.
- `pnpm tauri dev` and `pnpm tauri build` call `pnpm ide:prepare` first. It
  rebuilds if the staged runtime is absent, for a different architecture, or
  older than the vendored source or staging scripts. Release scripts run the
  full build and stage steps explicitly.

The staged resource directories are generated and ignored by Git. Theia's
source snapshot, Echo bridge extension, runtime lock file, and Node.js fallback
license are tracked. `src-tauri/.taurignore` prevents mass dependency staging
from repeatedly restarting the Rust dev process.

## Runtime boundary

`coding_theia_start` verifies that the selected project is an authorized
workspace, launches the bundled Node.js and Theia backend on `127.0.0.1`, and
returns its URL plus a fresh process token. It prefers a stable local port so
Theia can restore its browser layout, with an ephemeral port fallback. The
process and its log belong to the Tauri app and stop when the app exits.

The Theia iframe and React host use `postMessage` with a per-frame bridge token
and exact origin checks. The backend token authenticates Socket.IO and
protected file transfer endpoints without relying on third-party cookies in
the desktop webview. The backend remains loopback-only. Theia's standalone
cookie authentication still works when it is opened outside EchoAgent.

`@echoagent/theia-bridge` intercepts Theia file writes, moves, copies, and
deletions. The host checks the task phase before each operation, then syncs
the change set and task state after it completes. The bridge also reports the
active file to the Agent pane, opens files and web previews on request, and
reports Theia workspace changes. EchoAgent's project switcher is authoritative;
an in-IDE workspace switch resets the iframe to the selected Echo Code project.

## Smoke check

Build and stage the IDE, start its backend on a local port with
`ECHO_THEIA_EMBED_TOKEN`, then run `scripts/smoke-theia.mjs` with `THEIA_URL`,
the same token, and optionally `ECHO_SMOKE_EDIT=1` and
`ECHO_SMOKE_PREVIEW=1`. The smoke check verifies the iframe, IDE shell,
workspace event, and optional editor save and preview panel. It uses a
temporary file in `THEIA_WORKSPACE` and restores it afterward. It needs a
local Chrome installation or `CHROME_BIN`.
