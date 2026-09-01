# EchoAgent Vendored Runtime

This directory is a source snapshot tracked directly by the
`echo-agent-desktop` repository. It is not a Git submodule.

- Upstream: <https://github.com/xai-org/grok-build.git>
- Upstream revision: `c2ad97f87aea4303b6000a2c22128bc91ee76c9b`
- Upstream license: Apache License 2.0
- Imported: 2026-09-01

The checked-in snapshot includes the compatibility changes recorded under
`patches/grok-build/` and the EchoAgent protocol namespace migration performed
by `scripts/rename-runtime-namespace.*`. Modified files are maintained as part
of EchoAgent and are not endorsed by the upstream project.

When importing a newer upstream revision, use a temporary checkout, refresh and
apply the maintained patches, run the namespace migration there, replace only
the tracked source snapshot (never `target/` or nested Git metadata), update
`ECHOAGENT_VENDOR.json`, this file, `THIRD_PARTY_NOTICES.md`, and the changelog,
then run the complete frontend and Rust test suites before committing.
