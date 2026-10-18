# Vendored Theia language extensions

These are the original VSIX files listed in
`vendor/theia-platform/examples/browser/package.json`. Each archive contains
its own MIT license notice. `manifest.json` pins the SHA-256 of every archive.

`pnpm ide:build` verifies the archives and extracts them locally into
`vendor/theia-platform/plugins/`. It does not download plugins.

To refresh the archives after changing the pinned URLs, install the Theia npm
dependencies, run `pnpm ide:plugins:update`, and review the resulting archives
and hash manifest before committing them. This explicit command requires
network access and `curl`.

The original Git 1.95.3 VSIX remains unchanged. After SHA-256 verification,
`scripts/patch-theia-git-windowless.mjs` patches only its extracted background
Git version probe and Git.spawn entry. Windows receives windowsHide; other
platforms retain the original options. The patch pins both input and output
executable hashes and writes `extension/echoagent-windowless-patch.json` with
upstream provenance. Unknown versions, hashes or call shapes fail the build.
Runtime staging and cache admission require this marker and patched executable;
the marker is shipped inside the plugin and included in its tree fingerprint.
