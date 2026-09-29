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
