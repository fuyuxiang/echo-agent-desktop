# EchoAgent integration patch

Source: crates.io `tauri-plugin-updater` 2.9.0, package checksum `27cbc31740f4d507712550694749572ec0e43bdd66992db7599b89fbfd6b167b`, upstream <https://github.com/tauri-apps/plugins-workspace>. Upstream MIT and Apache-2.0 license files are preserved.

Only the Windows installer handoff changes. `install_without_exit` lets the host save recordings and flush Runtime before installing, then choose its controlled exit. The `ShellExecuteW` result is checked so a rejected/failed launch returns an error and preserves the application; cleanup is never run before a failed launch. Extracted installer files are retained for the external process, matching upstream's immediate-exit lifetime. The existing `install` API still exits on successful Windows installation.

Signature verification, pinned version, private CA client, archive extraction and other platform installation logic remain upstream 2.9.0. The host calls this API only after verified download. No real installation is performed by tests. The numerical Windows launch-result contract has a platform-independent unit test; actual Windows installer execution still requires Windows acceptance.
